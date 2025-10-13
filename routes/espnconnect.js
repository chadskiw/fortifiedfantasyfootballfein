// routes/espnconnect.js
const express = require('express');
const crypto  = require('crypto');

const router = express.Router();

// pull pool off the app (server.js does app.set('pg', pool))
function getPool(req) {
  return req.app.get('pg');
}

// ESPN read helper (uses all known cred candidates)
const { fetchFromEspnWithCandidates } = require('./espn/espnCred');

// ---------- helpers ----------
const sha256 = (s='') => crypto.createHash('sha256').update(String(s)).digest('hex');

function normalizeSwid(raw) {
  try {
    let v = decodeURIComponent(String(raw || '')).trim();
    if (!v) return '';
    v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
    if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
    return v.toUpperCase();
  } catch {
    return String(raw || '');
  }
}

function pickCreds(req, body = {}) {
  // precedence: headers -> body -> cookies -> query
  const h = req.headers || {};
  const q = req.query || {};
  const c = req.cookies || {};

  const swid = normalizeSwid(
    h['x-espn-swid'] || body.swid || c.SWID || q.SWID || q.swid || ''
  );
  const s2 = (h['x-espn-s2'] || body.s2 || c.espn_s2 || q.s2 || q.espn_s2 || '').trim();

  return { swid, s2 };
}

// write cookies for the UI (same-domain)
function setCredCookies(res, { swid, s2 }) {
  const opts = { httpOnly: false, sameSite: 'Lax', secure: true, domain: 'fortifiedfantasy.com', path: '/', maxAge: 31536000 };
  if (swid) res.cookie('SWID', swid, opts);
  if (s2)   res.cookie('espn_s2', s2, opts);
}

// ---------- DB upserts ----------
async function upsertCred(pool, { swid, s2, memberId = null, ref = 'espnconnect' }) {
  if (!swid || !s2) return { inserted: 0, updated: 0 };
  const swidHash = sha256(swid);
  const s2Hash   = sha256(s2);

  // existence check avoids assuming a specific unique index
  const { rows } = await pool.query(
    'select cred_id from ff_espn_cred where swid_hash = $1 limit 1',
    [swidHash]
  );

  if (rows.length) {
    await pool.query(
      `update ff_espn_cred
         set espn_s2   = $1,
             s2_hash   = $2,
             last_seen = now(),
             ref       = $3
       where swid_hash = $4`,
      [s2, s2Hash, ref, swidHash]
    );
    return { inserted: 0, updated: 1 };
  }

  await pool.query(
    `insert into ff_espn_cred
      (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
      values ($1, $2, $3, $4, $5, now(), now(), $6)`,
    [swid, s2, swidHash, s2Hash, memberId, ref]
  );
  return { inserted: 1, updated: 0 };
}

function buildLeagueUrls({ season, leagueId, teamId }) {
  const id = Number(leagueId);
  const team = Number(teamId);
  return {
    entry_url:       `https://fantasy.espn.com/football/team?leagueId=${id}&teamId=${team}&seasonId=${season}`,
    league_url:      `https://fantasy.espn.com/football/league?leagueId=${id}&seasonId=${season}`,
    fantasycast_url: `https://fantasy.espn.com/football/fantasycast?leagueId=${id}&teamId=${team}`,
    scoreboard_url:  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${id}?view=mScoreboard&filter=%7B%22schedule%22%3A%7B%22filterTeamIds%22%3A%7B%22value%22%3A%5B${team}%5D%7D%2C%22filterCurrentMatchupPeriod%22%3A%7B%22value%22%3Atrue%7D%7D%7D&peek=true`,
    signup_url:      'https://fantasy.espn.com/football/welcome'
  };
}

async function fetchLeagueMeta(req, { season, leagueId }) {
  // Use the Kona passthrough with cred candidates so private leagues work.
  const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`);
  upstream.searchParams.set('view', 'mSettings');
  const { status, body } = await fetchFromEspnWithCandidates(upstream.toString(), req, { leagueId });
  if (status < 200 || status >= 300) throw new Error('espn_league_meta_' + status);
  return JSON.parse(body || '{}');
}

async function fetchTeams(req, { season, leagueId }) {
  const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`);
  upstream.searchParams.set('view', 'mTeam');
  const { status, body } = await fetchFromEspnWithCandidates(upstream.toString(), req, { leagueId });
  if (status < 200 || status >= 300) throw new Error('espn_teams_' + status);
  return JSON.parse(body || '{}');
}

async function upsertFfl(pool, payload) {
  // Existence check (don’t assume constraints)
  const { season, leagueId, teamId } = payload;
  const exists = await pool.query(
    'select 1 from ff_sport_ffl where season = $1 and league_id = $2 and team_id = $3 limit 1',
    [season, Number(leagueId), Number(teamId)]
  );

  const srcJson  = JSON.stringify(payload.source_payload || {});
  const srcHash  = sha256(srcJson);

  if (exists.rowCount) {
    const q = `
      update ff_sport_ffl
         set league_name = $1,
             league_size = $2,
             team_name   = $3,
             team_logo_url = $4,
             entry_url     = $5,
             league_url    = $6,
             fantasycast_url = $7,
             scoreboard_url  = $8,
             signup_url      = $9,
             in_season       = $10,
             is_live         = $11,
             current_scoring_period = $12,
             source_payload  = $13,
             source_hash     = $14,
             last_seen_at    = now(),
             updated_at      = now()
       where season=$15 and league_id=$16 and team_id=$17`;
    const a = [
      payload.league_name,
      payload.league_size,
      payload.team_name,
      payload.team_logo_url,
      payload.entry_url,
      payload.league_url,
      payload.fantasycast_url,
      payload.scoreboard_url,
      payload.signup_url,
      payload.in_season,
      payload.is_live,
      payload.current_scoring_period,
      srcJson,
      srcHash,
      season, Number(leagueId), Number(teamId),
    ];
    await pool.query(q, a);
    return { inserted: 0, updated: 1 };
  }

  const q = `
    insert into ff_sport_ffl
      (char_code, season, league_id, team_id,
       league_name, league_size, team_name, team_logo_url,
       entry_url, league_url, fantasycast_url, scoreboard_url, signup_url,
       in_season, is_live, current_scoring_period,
       source_payload, source_hash,
       first_seen_at, last_seen_at, status, visibility, updated_at, last_synced_at)
    values
      ('ffl', $1, $2, $3,
       $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15,
       $16, $17,
       now(), now(), 'active', 'public', now(), now())`;
  const a = [
    season, Number(leagueId), Number(teamId),
    payload.league_name,
    payload.league_size,
    payload.team_name,
    payload.team_logo_url,
    payload.entry_url,
    payload.league_url,
    payload.fantasycast_url,
    payload.scoreboard_url,
    payload.signup_url,
    payload.in_season,
    payload.is_live,
    payload.current_scoring_period,
    srcJson,
    srcHash,
  ];
  await pool.query(q, a);
  return { inserted: 1, updated: 0 };
}

// ---------- main handler ----------
async function ingestHandler(req, res) {
  try {
    const pool = getPool(req);
    const body = req.body || {};
    const season = Number(body.season || req.query.season || new Date().getUTCFullYear());

    // creds
    const { swid, s2 } = pickCreds(req, body);
    if (!swid || !s2) {
      return res.status(400).json({ ok: false, error: 'missing_swid_or_s2' });
    }
    setCredCookies(res, { swid, s2 });

    // record creds
    const credResult = await upsertCred(pool, { swid, s2, ref: 'espnconnect' });

    // items to ingest
    let items = Array.isArray(body.items) ? body.items : [];
    const fromLeagues = Array.isArray(body.leagueIds) ? body.leagueIds : (Array.isArray(body.leagues) ? body.leagues : []);
    if (!items.length && fromLeagues.length) {
      // fall back to just leagueIds (assume teamId unknown)
      items = fromLeagues.map(id => ({ season, leagueId: Number(id), teamId: null, game: 'ffl' }));
    }

    const summary = {
      leaguesAttempted: items.length,
      leaguesSucceeded: 0,
      teamsInserted: 0,
      teamsUpdated: 0,
      credInserted: credResult.inserted,
      credUpdated: credResult.updated,
    };

    for (const it of items) {
      try {
        if (String(it.game || 'ffl').toLowerCase() !== 'ffl') continue;

        // fetch metadata needed for ff_sport_ffl
        const meta   = await fetchLeagueMeta(req, { season, leagueId: it.leagueId });
        const teamsJ = await fetchTeams(req,       { season, leagueId: it.leagueId });

        const settings = meta?.settings || {};
        const teamsArr = teamsJ?.teams || [];
        const team     = teamsArr.find(t => (t.id ?? t.teamId) === Number(it.teamId))
                      || teamsArr.find(t => (t.primaryOwner && String(t.primaryOwner).includes('SWID') && it.teamId == null))
                      || null;

        const league_name = settings?.name || meta?.name || '';
        const league_size = Number(settings?.size || teamsArr.length || 0);
        const team_name   = team?.location && team?.nickname ? `${team.location} ${team.nickname}` :
                            team?.teamName || team?.name || '';
        const team_logo   = team?.logo || team?.logos?.[0]?.url || null;

        const in_season = !!(meta?.status?.isActive ?? true);
        const is_live   = !!(meta?.status?.isLive ?? false);
        const current_scoring_period = Number(meta?.status?.currentScoringPeriod?.id || meta?.status?.currentScoringPeriodId || 0);

        const urls = buildLeagueUrls({ season, leagueId: it.leagueId, teamId: it.teamId || (team?.id ?? team?.teamId ?? 0) });

        const rowPayload = {
          season,
          leagueId: it.leagueId,
          teamId:   it.teamId || (team?.id ?? team?.teamId ?? 0),
          league_name,
          league_size,
          team_name,
          team_logo_url: team_logo,
          in_season,
          is_live,
          current_scoring_period,
          ...urls,
          source_payload: {
            league_settings: settings,
            team_raw: team || null,
          }
        };

        const r = await upsertFfl(pool, rowPayload);

        summary.leaguesSucceeded += 1;
        summary.teamsInserted     += r.inserted;
        summary.teamsUpdated      += r.updated;
      } catch (e) {
        // continue with others, but note failure in server logs
        console.error('[espnconnect ingest league failed]', it, e);
      }
    }

    // tolerate empty/short bodies (your FE now reads the JSON safely)
    res
      .status(200)
      .set('Cache-Control','no-store')
      .json({ ok: true, season, summary });

  } catch (e) {
    console.error('[espnconnect ingest fatal]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

// ---------- routes ----------
// both bases are mounted in server.js:
//   app.use('/api/espnconnect', router)
//   app.use('/api/platforms/espn', router)
router.post('/', ingestHandler);                 // /api/espnconnect
router.post('/ingest', ingestHandler);           // /api/espnconnect/ingest
router.post('/espnconnect', ingestHandler);      // /api/platforms/espn/espnconnect
router.post('/espnconnect/ingest', ingestHandler);

module.exports = router;
