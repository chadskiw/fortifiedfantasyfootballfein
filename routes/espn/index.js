// routes/espn/index.js
// Mount:
//   const espnRouter = require('./routes/espn');
//   app.use('/api/platforms/espn', espnRouter);

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

let db;
try { db = require('../../src/db/pool'); } catch { db = require('../../src/db/pool'); }
const pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') throw new Error('[espn] pg pool missing');

const fetch = global.fetch || require('node-fetch');

const DEBUG = process.env.FF_DEBUG_ESPN === '1';

// ---------------- utils ----------------
const ok  = (res, body = {}) => res.json({ ok: true, ...body });
const bad = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
const num = (v, d = null) => (Number.isFinite(+v) ? +v : d);
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

const S2_COOKIE_OPTS = Object.freeze({ httpOnly:true, secure:true, sameSite:'Lax', path:'/', maxAge:1000*60*60*24*30 });
function isGhost(memberId){
  return typeof memberId === 'string' && /^GHOST/i.test(memberId);
}

function safeNextURL(req, fallback = '/fein') {
  const to = (req.query.to || req.query.return || req.query.next || '').toString().trim();
  if (!to) return fallback;
  try {
    const u = new URL(to, `${req.protocol}://${req.get('host')}`);
    const sameHost  = u.host === req.get('host');
    const isRel     = !/^[a-z]+:/i.test(to);
    return (sameHost || isRel) ? (u.pathname + (u.search || '') + (u.hash || '')) : fallback;
  } catch { return fallback; }
}

function normalizeSwid(raw) {
  if (!raw) return null;
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.trim().replace(/^\{|\}$/g, '').toUpperCase();
  return `{${s}}`;
}
function normalizeS2(raw) {
  if (!raw) return null;
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/ /g, '+').trim();
  return s || null;
}
const GAMES = ['ffl','fba','flb','fhl'];

async function listOwnerLeagues(game, season, ownerGuid, cred) {
  const guid = normalizeSwid(ownerGuid); // "{GUID}"
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues`;
  const url  = `${base}?forTeamOwner=${encodeURIComponent(guid)}&view=mTeam&view=mSettings`;
  try {
    // returns an array of league bundles (not a single object)
    const arr = await espnFetchJSON(url, cred);
    if (!Array.isArray(arr)) return [];
    return arr.map(bundle => ({
      game,
      season,
      leagueId: String(bundle.id),
      bundle
    }));
  } catch (_) {
    return []; // no access or none found this season/game
  }
}
function hasInlineCreds(req){
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = (c.SWID || c.swid || h['x-espn-swid'] || '').trim();
  const s2   = (c.espn_s2 || c.ESPN_S2 || h['x-espn-s2'] || '').trim();
  return !!(swid && s2);
}

// ---------------- auth/session helpers ----------------
async function getAuthedMemberId(req) {
  const c = req.cookies || {};
  const memberId  = (c.ff_member_id || '').trim();
  const sessionId = (c.ff_session_id || '').trim();
  const logged    = (c.ff_logged_in || '') === '1';
  if (!memberId || !sessionId || !logged) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM ff_session WHERE session_id = $1 AND member_id = $2 LIMIT 1`,
    [sessionId, memberId]
  );
  return rows.length ? memberId : null;
}

async function getS2ForMember(memberId) {
  if (!memberId) return null;
  const { rows } = await pool.query(`
    SELECT espn_s2
      FROM ff_espn_cred
     WHERE member_id = $1
     ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
     LIMIT 1
  `, [memberId]);
  return (rows[0]?.espn_s2 && String(rows[0].espn_s2).trim()) || null;
}

async function getS2BySwidCookie(swidCookie) {
  if (!swidCookie) return null;
  const swidHash = sha256(swidCookie);
  const { rows } = await pool.query(`
    SELECT espn_s2
      FROM ff_espn_cred
     WHERE swid_hash = $1
     ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
     LIMIT 1
  `, [swidHash]);
  return (rows[0]?.espn_s2 && String(rows[0].espn_s2).trim()) || null;
}

async function maybeHydrateS2Cookie(req, res, next) {
  try {
    if (req.method !== 'GET') return next();
    if (req.cookies?.espn_s2) return next();
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return next();

    let s2 = await getS2ForMember(memberId);
    if (!s2) {
      const swidCookie = normalizeSwid(req.cookies?.SWID || req.cookies?.swid || '');
      if (swidCookie) s2 = await getS2BySwidCookie(swidCookie);
    }

    if (s2) res.cookie('espn_s2', s2, S2_COOKIE_OPTS);
    return next();
  } catch (e) {
    if (DEBUG) console.warn('[espn] hydrate s2 skipped:', e.message);
    return next();
  }
}

async function saveCredWithMember({ swid, s2, memberId, ref }) {
  const swidHash = sha256(swid);
  const s2Val    = (s2 && String(s2).trim()) ? String(s2).trim() : null;
  const s2Hash   = s2Val ? sha256(s2Val) : null;

  const upd = await pool.query(`
    UPDATE ff_espn_cred
       SET swid_hash = $2,
           member_id = $3,
           last_seen = now(),
           ref       = COALESCE($4, ref)
         ${s2Val ? ', espn_s2 = $5, s2_hash = $6' : ''}
     WHERE swid = $1
     RETURNING cred_id
  `, s2Val ? [swid, swidHash, memberId, ref || null, s2Val, s2Hash]
           : [swid, swidHash, memberId, ref || null]);

  if (upd.rowCount > 0) return upd.rows[0];

  const ins = await pool.query(`
    INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
    VALUES ($1, $2, $3, $4, $5, now(), now(), $6)
    RETURNING cred_id
  `, [swid, s2Val, swidHash, s2Hash, memberId, ref || null]);

  return ins.rows[0];
}

async function ensureQuickSnap(memberId, swid) {
  if (!memberId || !swid) return;
  const normalized = normalizeSwid(swid);

  const sel = await pool.query(
    `SELECT id, quick_snap FROM ff_quickhitter WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  const row = sel.rows[0];

  if (row) {
    const current = String(row.quick_snap || '').trim();
    if (!current) {
      await pool.query(
        `UPDATE ff_quickhitter
            SET quick_snap = $2,
                updated_at = now()
          WHERE id = $1`,
        [row.id, normalized]
      );
    }
    return;
  }

  await pool.query(
    `INSERT INTO ff_quickhitter
       (member_id, handle, quick_snap, color_hex, created_at, updated_at, is_member)
     VALUES
       ($1, NULL, $2,
        COALESCE((SELECT color_hex FROM ff_member WHERE member_id = $1 LIMIT 1), '#77E0FF'),
        now(), now(), FALSE)`,
    [memberId, normalized]
  );
}

// ---------------- ESPN cred resolution ----------------
async function getCredForRequest(req) {
  const cookies = req.cookies || {};
  const hdrs = req.headers || {};
  const memberId = await getAuthedMemberId(req);

  if (memberId) {
    const { rows } = await pool.query(`
      SELECT swid, espn_s2
        FROM ff_espn_cred
       WHERE member_id = $1
       ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
       LIMIT 1
    `, [memberId]);
    if (rows[0]?.swid && rows[0]?.espn_s2) {
      return { swid: normalizeSwid(rows[0].swid), espn_s2: normalizeS2(rows[0].espn_s2), memberId };
    }
  }

  const swidCookieRaw = cookies.SWID || cookies.swid || '';
  const swidCookie    = normalizeSwid(swidCookieRaw);
  const s2Cookie      = normalizeS2(cookies.espn_s2 || cookies.ff_espn_s2 || '');
  if (swidCookie && s2Cookie) return { swid: swidCookie, espn_s2: s2Cookie, memberId: memberId || null };

  if (swidCookie) {
    const swidHash = sha256(swidCookie);
    const { rows } = await pool.query(`
      SELECT swid, espn_s2
        FROM ff_espn_cred
       WHERE swid_hash = $1
       ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
       LIMIT 1
    `, [swidHash]);
    if (rows[0]?.espn_s2) {
      return {
        swid: normalizeSwid(rows[0].swid || swidCookie),
        espn_s2: normalizeS2(rows[0].espn_s2),
        memberId: memberId || null
      };
    }
  }

  const swidHdr = normalizeSwid(hdrs['x-espn-swid'] || hdrs['x-swid'] || '');
  const s2Hdr   = normalizeS2(hdrs['x-espn-s2']   || hdrs['x-s2']   || '');
  if (swidHdr && s2Hdr) return { swid: swidHdr, espn_s2: s2Hdr, memberId: memberId || null };

  return { swid: null, espn_s2: null, memberId: memberId || null };
}

async function ensureCred(req, res, next) {
  try {
    const cred = await getCredForRequest(req);
    if (!cred.swid || !cred.espn_s2) {
      return bad(res, 401, 'Missing SWID/espn_s2', {
        hint: 'Link via /api/platforms/espn/link or send X-ESPN-SWID/X-ESPN-S2'
      });
    }
    req._espn = cred;
    next();
  } catch (e) {
    console.error('[espn ensureCred]', e);
    return bad(res, 500, 'cred_lookup_failed');
  }
}

// Attach both Cookie + X- headers to ESPN fetch
async function espnFetchJSON(url, cred, init = {}) {
  const headers = Object.assign({}, init.headers || {});
  headers['X-ESPN-SWID'] = encodeURIComponent(cred.swid || '');
  headers['X-ESPN-S2']   = cred.espn_s2 || '';
  const swidRaw = decodeURIComponent(cred.swid || ''); // cookie needs raw {GUID}
  headers.cookie = `SWID=${swidRaw}; espn_s2=${cred.espn_s2}`;

  const res = await fetch(url, { method: 'GET', ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    const err = new Error(`[${res.status}] ${url} → ${text || 'request failed'}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------- link & probes ----------------
async function linkHandler(req, res) {
  try {
    const swid = normalizeSwid(req.body?.swid ?? req.query?.swid);
    const s2   = normalizeS2(req.body?.s2   ?? req.query?.s2);
    if (!swid) return bad(res, 400, 'missing_swid');

    const memberId = await getAuthedMemberId(req);
    const ref = (req.query?.ref || req.body?.ref || '').toString().slice(0, 64) || null;

    if (memberId) {
      await saveCredWithMember({ swid, s2, memberId, ref });
      await ensureQuickSnap(memberId, swid);
    }

    const maxYear = 1000 * 60 * 60 * 24 * 365;
    const base = { httpOnly: true, sameSite: 'Lax', secure: true, path: '/', maxAge: maxYear };
    res.cookie('SWID', swid, base);
    if (s2) res.cookie('espn_s2', s2, base);
    res.cookie('fein_has_espn', '1', { ...base, httpOnly: false, maxAge: 1000 * 60 * 60 * 24 * 90 });

    const next = safeNextURL(req, '/fein');
    return res.redirect(302, next);
  } catch (e) {
    console.error('[espn/link] error', e);
    return bad(res, 500, 'link_failed');
  }
}
router.use(maybeHydrateS2Cookie);
router.get('/link',  linkHandler);
router.post('/link', linkHandler);

router.get('/cred', async (req, res) => {
  try {
    const c = req.cookies || {};
    const h = req.headers || {};
    const theSwid = normalizeSwid(c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || '');
    const s2      = normalizeS2(c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || '');
    const memberId = await getAuthedMemberId(req);

    if (memberId && theSwid && !isGhost(memberId)) {
      await safeSaveCredWithMember({ swid: theSwid, s2, memberId, ref: 'cred-probe' });
      await ensureQuickSnap(memberId, theSwid);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, hasCookies: !!(theSwid && s2) });
  } catch (e) {
    console.error('[espn/cred] error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});



// ---------------- simple team proxy ----------------
router.get('/teams', ensureCred, async (req, res) => {
  try {
    const game    = (req.query.game || 'ffl').toString().toLowerCase();
    const season  = num(req.query.season, new Date().getUTCFullYear());
    const leagueId = String(req.query.leagueId || '').trim();
    if (!season || !leagueId) return bad(res, 400, 'season and leagueId required');

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await espnFetchJSON(url, req._espn);

    const teams = (data.teams || []).map(t => ({
      id: t.id,
      location: t.location,
      nickname: t.nickname,
      logo: t.logo || null,
      owners: t.owners || []
    }));

    return ok(res, { game, season, leagueId, teams });
  } catch (e) {
    console.error('[espn/teams]', e);
    return bad(res, e.status || 500, e.message || 'proxy_failed');
  }
});

// ============================================================================
//                       OWNER → MEMBER MAPPING + GHOSTS
// ============================================================================

async function lookupMemberByOwnerGuid(ownerGuid) {
  if (!ownerGuid) return null;
  const normalized = normalizeSwid(ownerGuid);
  const { rows } = await pool.query(
    `SELECT member_id
       FROM ff_espn_cred
      WHERE swid = $1
      ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
      LIMIT 1`,
    [normalized]
  );
  return rows[0]?.member_id || null;
}

async function nextGhostIdForLeague(platform, season, leagueId) {
  const { rows } = await pool.query(
    `SELECT member_id
       FROM ff_team_owner
      WHERE platform=$1 AND season=$2 AND league_id=$3
        AND owner_kind='ghost' AND member_id ~ '^GHOST[0-9]{3,}$'
      ORDER BY member_id DESC
      LIMIT 1`,
    [platform, season, String(leagueId)]
  );
  let n = 0;
  if (rows[0]?.member_id) {
    const m = rows[0].member_id.match(/^GHOST(\d+)$/);
    if (m) n = parseInt(m[1], 10);
  }
  const next = String(n + 1).padStart(3, '0');
  return `GHOST${next}`;
}

async function upsertTeamOwner({ platform, season, leagueId, teamId, memberId, ownerKind, espnOwnerGuids }) {
  await pool.query(
    `INSERT INTO ff_team_owner
       (platform, season, league_id, team_id, member_id, owner_kind, espn_owner_guids, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (platform, season, league_id, team_id)
     DO UPDATE SET
       member_id = EXCLUDED.member_id,
       owner_kind = EXCLUDED.owner_kind,
       espn_owner_guids = EXCLUDED.espn_owner_guids,
       updated_at = now()`,
    ['espn', season, String(leagueId), String(teamId), String(memberId), ownerKind, espnOwnerGuids || null]
  );
}

// ============================================================================
//                 FAN API → MEMBERSHIPS (all games/seasons/leagues)
// ============================================================================

/**
 * Returns array of: { game:'ffl'|'fba'|'flb'|'fhl', season:2025, leagueId:'...', teamId:'7'|null }
 */
async function fetchFanMemberships(ownerGuid, cred) {
  const guid = normalizeSwid(ownerGuid);
  const tries = [
    `https://fantasy.espn.com/apis/v2/fans/${encodeURIComponent(guid)}`,
    `https://site.api.espn.com/apis/fantasy/v2/fans/${encodeURIComponent(guid)}`,
  ];

  for (const url of tries) {
    try {
      const data = await espnFetchJSON(url, cred);

      if (Array.isArray(data?.memberships)) {
        return data.memberships
          .map(m => ({
            game: (m.gameId || m.game || '').toLowerCase(),
            season: Number(m.seasonId || m.season),
            leagueId: String(m.leagueId || m.leagueID || m.lid || ''),
            teamId: m.teamId != null ? String(m.teamId) : null
          }))
          .filter(x => x.game && x.season && x.leagueId);
      }

      if (data?.games && typeof data.games === 'object') {
        const out = [];
        for (const [game, gval] of Object.entries(data.games)) {
          const seasonsObj = gval?.seasons || {};
          for (const [seasonStr, arr] of Object.entries(seasonsObj)) {
            const season = Number(seasonStr);
            if (!Array.isArray(arr)) continue;
            for (const row of arr) {
              const leagueId = String(row.leagueId || row.leagueID || row.lid || '');
              if (!leagueId) continue;
              out.push({
                game: game.toLowerCase(),
                season,
                leagueId,
                teamId: row.teamId != null ? String(row.teamId) : null
              });
            }
          }
        }
        if (out.length) return out;
      }
    } catch (e) {
      // try next
    }
  }
  return [];
}

// ============================================================================
//               SNAPSHOT WRITERS → ff_sport_[ffl|fba|flb|fhl]
// ============================================================================

const SUPPORTED_GAMES = new Set(['ffl','fba','flb','fhl']);

function gameToPretty(game){
  switch (game) {
    case 'ffl': return { char_code: 'F', num_code: 1, sport: 'football'  };
    case 'fba': return { char_code: 'B', num_code: 2, sport: 'basketball'};
    case 'flb': return { char_code: 'L', num_code: 3, sport: 'baseball'  };
    case 'fhl': return { char_code: 'H', num_code: 4, sport: 'hockey'    };
    default:     return { char_code: '?', num_code: 0, sport: game };
  }
}

/**
 * Pull league bundle from ESPN (mTeam + mSettings) for any game.
 */
async function fetchLeagueBundle(game, season, leagueId, cred) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = `${base}?view=mTeam&view=mSettings`;
  const data = await espnFetchJSON(url, cred);
  return data;
}
// Keep "link-status" for the index page (alias of /authcheck)
router.get('/link-status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const hasSwid = !!(c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid']);
  const hasS2   = !!(c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2']);
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, step: (hasSwid && hasS2) ? 'logged_in' : 'link_needed' });
});
// Lightweight poll endpoint the homepage expects
router.get('/poll', async (req, res) => {
  try {
    const size = Number(req.query.size) || 10;
    const c = req.cookies || {};
    const h = req.headers || {};
    const swid = (c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null);
    const s2   = (c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null);

    // don’t trip your immutability trigger: this is read-only status
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      size,
      hasCreds: !!(swid && s2),
      // keep these keys stable in case the UI reads them
      data: [],
      meta: { ts: Date.now() }
    });
  } catch (e) {
    return res.status(200).json({ ok: true, size: Number(req.query.size)||10, hasCreds: false, data: [], meta: { ts: Date.now() } });
  }
});

/**
 * Upsert all teams from a league into ff_sport_<game>.
 * Relies on a common schema across your ff_sport_* tables (as in ff_sport_ffl).
 */
async function upsertLeagueIntoSportTable(game, season, leagueId, bundle) {
  const table = `ff_sport_${game}`;            // e.g. ff_sport_ffl
  const char_code = game;                      // 'ffl' | 'fba' | 'flb' | 'fhl'

  // get num_code from your map
  const { rows: mapRows } = await pool.query(
    `SELECT num_code FROM ff_sport_code_map WHERE char_code = $1 LIMIT 1`,
    [char_code]
  );
  const num_code = mapRows[0]?.num_code ?? null;

  const leagueName  = bundle?.settings?.name || bundle?.metadata?.leagueName || bundle?.leagueName || null;
  const leagueSize  = Array.isArray(bundle?.teams) ? bundle.teams.length : null;

  const rows = (bundle?.teams || []).map(t => {
    const teamName = `${t.location || ''} ${t.nickname || ''}`.trim();
    const payload  = {
      _kind: 'espn.mTeam+mSettings',
      pulled_at: new Date().toISOString(),
      league: { id: String(leagueId), name: leagueName },
      team: t
    };
    const source_hash = sha256(JSON.stringify(payload));

    return {
      char_code,
      season,
      num_code,
      sport: char_code,               // keep same as char_code for now (you can rename with a join later)
      competition_type: 'league',
      total_count: leagueSize,
      unique_sid_count: null,
      unique_member_count: null,
      table_name: table,
      platform: 'espn',
      league_id: String(leagueId),
      team_id: String(t.id),
      league_name: leagueName,
      league_size: leagueSize,
      team_name: teamName || '',
      handle: null,
      team_logo_url: t.logo || null,
      in_season: true,
      is_live: null,
      current_scoring_period: bundle?.scoringPeriodId || bundle?.status?.currentMatchupPeriod || null,
      entry_url: null,
      league_url: null,
      fantasycast_url: null,
      scoreboard_url: null,
      signup_url: null,
      scoring_json: null,
      draft_json: null,
      source_payload: payload,
      reaction_counts: null,
      source_hash,
      source_etag: null,
      visibility: 'public',
      status: 'ok'
    };
  });

  if (!rows.length) return { table, inserted: 0, updated: 0 };

  // Build one big INSERT ... ON CONFLICT
  const cols = [
    'char_code','season','num_code','sport','competition_type',
    'total_count','unique_sid_count','unique_member_count','table_name',
    // first_seen_at, last_seen_at are NOW() in VALUES
    'platform','league_id','team_id','league_name','league_size','team_name','handle',
    'team_logo_url','in_season','is_live','current_scoring_period',
    'entry_url','league_url','fantasycast_url','scoreboard_url','signup_url',
    'scoring_json','draft_json','source_payload','reaction_counts','source_hash','source_etag',
    'visibility','status'
  ];
  const per = cols.length;
  const placeholders = rows.map((_, i) => {
    const base = i*per;
    const list = Array.from({length: per}, (_, j) => `$${base + j + 1}`).join(', ');
    return `(${list}, now(), now())`; // append first_seen_at/last_seen_at
  }).join(',\n');

  const text = `
    INSERT INTO ${table} (
      ${cols.join(', ')},
      first_seen_at, last_seen_at
    )
    VALUES
    ${placeholders}
    ON CONFLICT (platform, season, league_id, team_id)
    DO UPDATE SET
      league_name = EXCLUDED.league_name,
      league_size = EXCLUDED.league_size,
      team_name   = EXCLUDED.team_name,
      team_logo_url = EXCLUDED.team_logo_url,
      current_scoring_period = EXCLUDED.current_scoring_period,
      source_payload = EXCLUDED.source_payload,
      source_hash = EXCLUDED.source_hash,
      visibility = EXCLUDED.visibility,
      status = EXCLUDED.status,
      updated_at = now(),
      last_synced_at = now()
  `;

  const vals = [];
  for (const r of rows) {
    vals.push(
      r.char_code, r.season, r.num_code, r.sport, r.competition_type,
      r.total_count, r.unique_sid_count, r.unique_member_count, r.table_name,
      r.platform, r.league_id, r.team_id, r.league_name, r.league_size, r.team_name, r.handle,
      r.team_logo_url, r.in_season, r.is_live, r.current_scoring_period,
      r.entry_url, r.league_url, r.fantasycast_url, r.scoreboard_url, r.signup_url,
      r.scoring_json, r.draft_json, r.source_payload, r.reaction_counts, r.source_hash, r.source_etag,
      r.visibility, r.status
    );
  }

  // If anything is off (missing table/columns/index), we throw so you can see it.
  await pool.query(text, vals);
  return { table, inserted: rows.length, updated: 'on_conflict' };
}


/**
 * Ingest snapshot for one membership (one league).
 * Returns a per-league result describing what happened.
 */
async function ingestDiscoveredLeague({ game, season, leagueId }, cred) {
  const g = String(game).toLowerCase();
  if (!SUPPORTED_GAMES.has(g)) {
    return { game: g, season, leagueId: String(leagueId), queued: false, reason: 'unsupported_game' };
  }

  try {
    const bundle = await fetchLeagueBundle(g, season, leagueId, cred);
    const write = await upsertLeagueIntoSportTable(g, season, leagueId, bundle);
    return { game: g, season, leagueId: String(leagueId), queued: true, write };
  } catch (e) {
    return { game: g, season, leagueId: String(leagueId), queued: false, reason: e.message || 'probe_or_write_failed' };
  }
}
// REPLACE the whole function with this version
async function safeSaveCredWithMember({ swid, s2, memberId, ref }) {
  const swidHash = sha256(swid);
  const s2Val  = (s2 && String(s2).trim()) ? String(s2).trim() : null;
  const s2Hash = s2Val ? sha256(s2Val) : null;

  // Look up by SWID first
  const { rows } = await pool.query(
    `SELECT cred_id, member_id FROM ff_espn_cred WHERE swid = $1 LIMIT 1`,
    [swid]
  );

  if (rows[0]?.cred_id) {
    const credId = rows[0].cred_id;

    // If row already belongs to a different member, DO NOT rebind (respect the trigger).
    if (rows[0].member_id && rows[0].member_id !== memberId) {
      if (s2Val) {
        await pool.query(
          `UPDATE ff_espn_cred
              SET swid_hash = $2,
                  espn_s2   = $3,
                  s2_hash   = $4,
                  last_seen = now(),
                  ref       = COALESCE($5, ref)
            WHERE cred_id   = $1`,
          [credId, swidHash, s2Val, s2Hash, ref || null]
        );
      } else {
        await pool.query(
          `UPDATE ff_espn_cred
              SET swid_hash = $2,
                  last_seen = now(),
                  ref       = COALESCE($3, ref)
            WHERE cred_id   = $1`,
          [credId, swidHash, ref || null]
        );
      }
      return { cred_id: credId, rebound: false, keptOwner: true };
    }

    // Same owner (or empty) → safe to set member_id and optionally s2
    if (s2Val) {
      await pool.query(
        `UPDATE ff_espn_cred
            SET swid_hash = $2,
                member_id = $3,
                espn_s2   = $4,
                s2_hash   = $5,
                last_seen = now(),
                ref       = COALESCE($6, ref)
         WHERE cred_id   = $1`,
        [credId, swidHash, memberId, s2Val, s2Hash, ref || null]
      );
    } else {
      await pool.query(
        `UPDATE ff_espn_cred
            SET swid_hash = $2,
                member_id = $3,
                last_seen = now(),
                ref       = COALESCE($4, ref)
         WHERE cred_id   = $1`,
        [credId, swidHash, memberId, ref || null]
      );
    }
    return { cred_id: credId, rebound: false, keptOwner: false };
  }

  // Fresh insert
  const ins = await pool.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
     VALUES ($1, $2, $3, $4, $5, now(), now(), $6)
     RETURNING cred_id`,
    [swid, s2Val, swidHash, s2Hash, memberId, ref || null]
  );
  return ins.rows[0];
}

// ============================================================================
//                       GHOST INGEST (UPGRADED)
// ============================================================================

/**
 * POST /ghost/ingest
 * Body/query: { season, leagueId }  (game implied 'ffl' entry point)
 * 1) Map owners → member_id (real/ghost)
 * 2) For each unique owner GUID → Fan API → ingest ALL leagues across FFL/FBA/FLB/FHL
 * 3) Write snapshots into ff_sport_[ffl|fba|flb|fhl]
 */
router.post('/ghost/ingest', ensureCred, async (req, res) => {
  try {
    const season   = num(req.body?.season ?? req.query?.season);
    const leagueId = (req.body?.leagueId ?? req.query?.leagueId ?? '').toString().trim();
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    // Step 0: Read the seed league (football) to discover owners
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await espnFetchJSON(url, req._espn);

    const teams = (data.teams || []);
    if (!teams.length) return ok(res, { season, leagueId, platform: 'espn', mapped: [], fanIngest: [], note: 'no_teams_found' });

    // ---------- Step 1: owners → member_id ----------
    const mapped = [];
    const ownerGuidSet = new Set();

    for (const t of teams) {
      const teamId = String(t.id);
      const ownerGuids = (t.owners || []).map(o => normalizeSwid(o));
      ownerGuids.forEach(g => ownerGuidSet.add(g));

      let memberId = null;
      let ownerKind = 'ghost';
      for (const guid of ownerGuids) {
        const mid = await lookupMemberByOwnerGuid(guid);
        if (mid) { memberId = mid; ownerKind = 'real'; break; }
      }

      if (!memberId) {
        const existing = await pool.query(
          `SELECT member_id, owner_kind
             FROM ff_team_owner
            WHERE platform='espn' AND season=$1 AND league_id=$2 AND team_id=$3
            LIMIT 1`,
          [season, leagueId, teamId]
        );
        if (existing.rows[0]?.member_id) {
          memberId = existing.rows[0].member_id;
          ownerKind = existing.rows[0].owner_kind || 'ghost';
        } else {
          memberId = await nextGhostIdForLeague('espn', season, leagueId);
          ownerKind = 'ghost';
        }
      }

      await upsertTeamOwner({
        platform: 'espn',
        season,
        leagueId,
        teamId,
        memberId,
        ownerKind,
        espnOwnerGuids: ownerGuids.length ? ownerGuids : null
      });

      mapped.push({
        teamId,
        teamName: `${t.location || ''} ${t.nickname || ''}`.trim(),
        logo: t.logo || null,
        owners: ownerGuids,
        memberId,
        ownerKind
      });
    }

    // ---------- Step 2: Fan API for each owner; ingest ALL memberships ----------
// ---------- Step 2: For each unique owner GUID → enumerate all leagues across games/seasons ----------
const uniqueOwners = Array.from(ownerGuidSet);
const fanIngestResults = [];
const thisYear = new Date().getUTCFullYear();
const seasonsToCheck = [];
for (let yr = thisYear; yr >= thisYear - 6; yr--) seasonsToCheck.push(yr); // 7-year sweep

for (const ownerGuid of uniqueOwners) {
  const discovered = [];
  for (const game of GAMES) {
    for (const season of seasonsToCheck) {
      const leagues = await listOwnerLeagues(game, season, ownerGuid, req._espn);
      for (const L of leagues) {
        // If caller season was specified and game is ffl, we still include other seasons/sports.
        discovered.push({ game: L.game, season: L.season, leagueId: L.leagueId, bundle: L.bundle || null });
      }
    }
  }

  // Dedup by (game, season, leagueId)
  const seen = new Set();
  const deduped = [];
  for (const d of discovered) {
    const k = `${d.game}|${d.season}|${d.leagueId}`;
    if (!seen.has(k)) { seen.add(k); deduped.push(d); }
  }

  // Write snapshots for each discovered league
  const results = [];
  for (const d of deduped) {
    try {
      const bundle = d.bundle || await fetchLeagueBundle(d.game, d.season, d.leagueId, req._espn);
      const write  = await upsertLeagueIntoSportTable(d.game, d.season, d.leagueId, bundle);
      results.push({ game: d.game, season: d.season, leagueId: d.leagueId, queued: true, write });
    } catch (e) {
      results.push({ game: d.game, season: d.season, leagueId: d.leagueId, queued: false, reason: e.message || 'probe_or_write_failed' });
    }
  }

  fanIngestResults.push({ ownerGuid, discovered: deduped.map(({bundle, ...x})=>x), results });
}

return ok(res, { platform:'espn', season, leagueId, count: mapped.length, mapped, fanIngest: fanIngestResults });

  } catch (e) {
    console.error('[espn/ghost/ingest]', e);
    return bad(res, e.status || 500, e.message || 'ghost_ingest_failed');
  }
});

// ---------------- owners viewer ----------------
router.get('/owners', async (req, res) => {
  try {
    const season   = num(req.query?.season);
    const leagueId = (req.query?.leagueId ?? '').toString().trim();
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    const { rows } = await pool.query(
      `SELECT platform, season, league_id, team_id, member_id, owner_kind, espn_owner_guids, created_at, updated_at
         FROM ff_team_owner
        WHERE platform='espn' AND season=$1 AND league_id=$2
        ORDER BY team_id::int NULLS LAST, team_id ASC`,
      [season, leagueId]
    );
    return ok(res, { platform: 'espn', season, leagueId, owners: rows });
  } catch (e) {
    console.error('[espn/owners]', e);
    return bad(res, 500, 'server_error');
  }
});

// ---------------- legacy ingest acceptor (kept) ----------------
async function ingestHandler(req, res) {
  try {
    const memberId = await getAuthedMemberId(req);          // may be null or a GHOST
    const season   = num(req.query?.season ?? req.body?.season);
    const leagueId = (req.query?.leagueId ?? req.body?.leagueId ?? '').toString().trim();
    const teamId   = (req.query?.teamId   ?? req.body?.teamId   ?? '').toString().trim() || null;
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    // If caller provided creds inline (cookie/header), allow anonymous run
    const hdrSwid = normalizeSwid(req.headers['x-espn-swid'] || req.headers['x-swid'] || '');
    const hdrS2   = normalizeS2(req.headers['x-espn-s2']   || req.headers['x-s2']   || '');
    const allowAnonViaCookies = hasInlineCreds(req);

    if (hdrSwid && hdrS2 && memberId && !isGhost(memberId)) {
      // Persist only for real members; ghosts/anon skip writes to ff_espn_cred
      await safeSaveCredWithMember({ swid: hdrSwid, s2: hdrS2, memberId, ref: 'ingest' });
      await ensureQuickSnap(memberId, hdrSwid);
    } else if (!memberId && !allowAnonViaCookies) {
      // Neither session nor inline creds → block
      return bad(res, 401, 'unauthorized');
    }

    // Accept the job (your worker/ghost-ingest path will pick it up downstream)
    return res.status(202).json({
      ok: true,
      accepted: true,
      season,
      leagueId: String(leagueId),
      teamId: teamId ? String(teamId) : null
    });
  } catch (e) {
    console.error('[espn/ingest]', e);
    return bad(res, 500, 'server_error');
  }
}


router.post('/ingest', ingestHandler);
router.post('/ingest/espn/fan', ingestHandler);

module.exports = router;
