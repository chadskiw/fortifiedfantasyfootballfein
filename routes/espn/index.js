// routes/espn/index.js
// Mount in server.js like:
//   const espnRouter = require('./routes/espn');
//   app.use('/api/platforms/espn', espnRouter);   // canonical
//   app.use('/api/espn', espnRouter);             // legacy short base (bookmarklet)
//   app.use('/api/espn-auth', espnRouter);        // to satisfy /api/espn-auth/creds (alias)
//   app.get('/link', (req, res) => {
//     const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
//     res.redirect(302, `/api/espn/link${qs}`);
//   });

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

let db;
try { db = require('../../src/db/pool'); } catch { db = require('../../src/db/pool'); }
const pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') throw new Error('[espn] pg pool missing');

const fetch = global.fetch || require('node-fetch');
const DEBUG = process.env.FF_DEBUG_ESPN === '1';

// --- AUTO-HYDRATE ESPN S2 WHEN USER IS LOGGED IN ---
const S2_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
});

// -------------- small utils --------------
const ok  = (res, body = {}) => res.json({ ok: true, ...body });
const bad = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
const num = (v, d = null) => (Number.isFinite(+v) ? +v : d);
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

function safeNextURL(req, fallback = '/fein') {
  const to = (req.query.to || req.query.return || req.query.next || '').toString().trim();
  if (!to) return fallback;
  try {
    const u = new URL(to, `${req.protocol}://${req.get('host')}`);
    const sameHost  = u.host === req.get('host');
    const isRel     = !/^[a-z]+:/i.test(to);
    return (sameHost || isRel) ? (u.pathname + (u.search || '') + (u.hash || '')) : fallback;
  } catch {
    return fallback;
  }
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

// ---------------- session helpers ----------------
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

// ---------------- DB helpers (existing) ----------------
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
  if (swidCookie && s2Cookie) {
    return { swid: swidCookie, espn_s2: s2Cookie, memberId: memberId || null };
  }

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

// Attach both Cookie + X- headers
async function espnFetchJSON(url, cred, init = {}) {
  const headers = Object.assign({}, init.headers || {});
  headers['X-ESPN-SWID'] = encodeURIComponent(cred.swid || '');
  headers['X-ESPN-S2']   = cred.espn_s2 || '';
  const swidRaw = decodeURIComponent(cred.swid || ''); // ESPN cookie expects raw {GUID}
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

// ---------------- link endpoints ----------------
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

// ---------------- probes / aliases ----------------
async function credProbe(req, res) {
  try {
    const c = req.cookies || {};
    const h = req.headers || {};
    const theSwid = normalizeSwid(c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || '');
    const s2   = normalizeS2(c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || '');
    const memberId = await getAuthedMemberId(req);

    if (memberId && theSwid) {
      await saveCredWithMember({ swid: theSwid, s2, memberId, ref: 'cred-probe' });
      await ensureQuickSnap(memberId, theSwid);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, hasCookies: !!(theSwid && s2) });
  } catch (e) {
    console.error('[espn/cred]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
router.get('/cred', credProbe);
router.get('/creds', credProbe);
router.get('/authcheck', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control','no-store');
  ok(res, { step: (swid && s2) ? 'logged_in' : 'link_needed' });
});

// ---------------- server-side ESPN proxies ----------------
router.get('/teams', ensureCred, async (req, res) => {
  try {
    const season = num(req.query.season, new Date().getUTCFullYear());
    const leagueId = String(req.query.leagueId || '').trim();
    if (!season || !leagueId) return bad(res, 400, 'season and leagueId required');

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await espnFetchJSON(url, req._espn);

    const teams = (data.teams || []).map(t => ({
      id: t.id,
      location: t.location,
      nickname: t.nickname,
      logo: t.logo || null,
      owners: t.owners || []   // often ESPN account {GUID}s
    }));

    return ok(res, { season, leagueId, teams });
  } catch (e) {
    console.error('[espn/teams]', e);
    return bad(res, e.status || 500, e.message || 'proxy_failed');
  }
});

router.get('/roster', ensureCred, async (req, res) => {
  try {
    const season = num(req.query.season, new Date().getUTCFullYear());
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = String(req.query.teamId   || '').trim();
    const week     = req.query.week ? Number(req.query.week) : undefined;
    if (!season || !leagueId || !teamId) {
      return bad(res, 400, 'season, leagueId, teamId required');
    }

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const view = week ? `mRoster&scoringPeriodId=${week}` : 'mRoster';
    const url  = `${base}?forTeamId=${teamId}&view=${view}`;

    const data = await espnFetchJSON(url, req._espn);
    const team = (data.teams || []).find(t => String(t.id) === String(teamId)) || {};
    const entries = (team.roster && team.roster.entries) || [];

    return ok(res, { season, leagueId, teamId, entries });
  } catch (e) {
    console.error('[espn/roster]', e);
    return bad(res, e.status || 500, e.message || 'proxy_failed');
  }
});

// ============================================================================
//                           GHOST OWNERSHIP INGEST
// ============================================================================

/**
 * Try to resolve a real FEIN member_id from an ESPN owner GUID ('{GUID}').
 * We treat the owner GUID as a SWID and look for any ff_espn_cred rows that match.
 */
async function lookupMemberByOwnerGuid(ownerGuid) {
  if (!ownerGuid) return null;
  const normalized = normalizeSwid(ownerGuid); // ensure {GUID} form
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

/**
 * Allocate the next GHOST id for this (platform, season, leagueId).
 * Pattern: GHOST001, GHOST002, ...
 */
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

/**
 * Upsert team-owner mapping.
 */
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
    [platform, season, String(leagueId), String(teamId), String(memberId), ownerKind, espnOwnerGuids || null]
  );
}

/**
 * POST /ghost/ingest
 * Body or query: { season, leagueId }
 * Uses caller’s SWID/S2 to pull league teams, then maps owners → member_id.
 * Any team with no resolvable member gets a GHOST### id (per league).
 */
router.post('/ghost/ingest', ensureCred, async (req, res) => {
  try {
    const season   = num(req.body?.season ?? req.query?.season);
    const leagueId = (req.body?.leagueId ?? req.query?.leagueId ?? '').toString().trim();
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    // Pull league teams with owners[]
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await espnFetchJSON(url, req._espn);

    const teams = (data.teams || []);
    if (!teams.length) return ok(res, { season, leagueId, platform: 'espn', mapped: [], note: 'no_teams_found' });

    const mapped = [];
    for (const t of teams) {
      const teamId = String(t.id);
      const ownerGuids = (t.owners || []).map(o => normalizeSwid(o)); // array of '{GUID}'
      let memberId = null;
      let ownerKind = 'ghost';

      // Try to find a real member via any owner GUID
      for (const guid of ownerGuids) {
        const mid = await lookupMemberByOwnerGuid(guid);
        if (mid) { memberId = mid; ownerKind = 'real'; break; }
      }

      // If still not found, allocate/keep a ghost
      if (!memberId) {
        // If there is already a mapping, keep it (don’t churn ghost IDs)
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

    return ok(res, {
      platform: 'espn',
      season,
      leagueId,
      count: mapped.length,
      mapped
    });
  } catch (e) {
    console.error('[espn/ghost/ingest]', e);
    return bad(res, e.status || 500, e.message || 'ghost_ingest_failed');
  }
});

/**
 * GET /owners?season=&leagueId=
 * Quick viewer for current mappings
 */
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

// ---------------- primary ingest handler (existing alias kept) ----------------
async function ingestHandler(req, res) {
  try {
    const memberId = await getAuthedMemberId(req);
    if (!memberId) return bad(res, 401, 'unauthorized');

    const season   = num(req.query?.season ?? req.body?.season);
    const leagueId = (req.query?.leagueId ?? req.body?.leagueId ?? '').toString().trim();
    const teamId   = (req.query?.teamId   ?? req.body?.teamId   ?? '').toString().trim() || null;
    if (!season)   return bad(res, 400, 'missing_param', { field: 'season' });
    if (!leagueId) return bad(res, 400, 'missing_param', { field: 'leagueId' });

    const hdrSwid = normalizeSwid(req.headers['x-espn-swid'] || req.headers['x-swid'] || '');
    const hdrS2   = normalizeS2(req.headers['x-espn-s2']   || req.headers['x-s2']   || '');
    if (hdrSwid && hdrS2) {
      await saveCredWithMember({ swid: hdrSwid, s2: hdrS2, memberId, ref: 'ingest' });
      await ensureQuickSnap(memberId, hdrSwid);
    } else {
      const row = await pool.query(
        `SELECT swid FROM ff_espn_cred WHERE member_id=$1 AND swid IS NOT NULL ORDER BY last_seen DESC NULLS LAST LIMIT 1`,
        [memberId]
      );
      if (row.rows[0]?.swid) {
        await ensureQuickSnap(memberId, row.rows[0].swid);
      } else {
        return bad(res, 412, 'espn_not_linked', { needAuth: true });
      }
    }

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
