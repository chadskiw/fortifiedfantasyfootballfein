// src/routes/espn/index.js
// Multi-game ESPN ingest + link endpoint (no HTML, JSON only)
//
// Endpoints:
//   GET /api/espn/status
//   GET /api/espn/discover?season=2025[&game=ffl|games=all|games=ffl,fba]
//   GET /api/espn/leagues?season=2025[&inject=ID,ID][&game=ffl|games=all|games=ffl,fba]
//   GET /api/espn/leagues?seasons=2019-2025[&games=all]
//   GET /api/espn/link?swid={...}&s2=... [&games=all|ffl,fba] [&season=2025|&seasons=2019-2025]
//     → sets cookies, upserts ff_espn_cred, ingests, then 302 → /fein
//
// Default game is ffl. Supported: ffl (football), fba (basketball), flb (baseball), fhl (hockey).

const express = require('express');
const router  = express.Router();

// ---- pool import that works with either default or named export ----
let pool = require('../../db/pool');
if (pool && pool.pool && typeof pool.pool.query === 'function') pool = pool.pool;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[espn] pg pool missing/invalid import');
}

router.use(express.json({ limit: '1mb' }));

/* ------------------------------- config ------------------------------ */
const SUPPORTED_GAMES = ['ffl','fba','flb','fhl'];
const DEFAULT_GAME = 'ffl';

/* -------------------------------- utils ------------------------------ */
function readCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  let swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  let s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  if (swid) {
    const dec = decodeURIComponent(String(swid));
    swid = /^\{.*\}$/.test(dec) ? dec : `{${dec.replace(/^\{?|\}?$/g,'')}}`;
  }
  return { swid, s2 };
}

function parseSeasons(qSeason, qSeasons) {
  const thisYear = new Date().getUTCFullYear();
  if (qSeasons) {
    const s = String(qSeasons).trim().toLowerCase();
    if (s === 'all') {
      const from = thisYear - 5; // last 6 years
      return Array.from({length: (thisYear - from + 1)}, (_,i)=>from+i);
    }
    const range = s.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (range) {
      const a = parseInt(range[1],10), b = parseInt(range[2],10);
      if (a && b && b >= a) return Array.from({length: b-a+1},(_,i)=>a+i);
    }
    return s.split(',').map(x=>parseInt(x,10)).filter(Boolean);
  }
  const one = qSeason ? parseInt(qSeason,10) : thisYear;
  return [one];
}

function parseGames(qGame, qGames) {
  if (qGames) {
    const s = String(qGames).trim().toLowerCase();
    if (s === 'all') return [...SUPPORTED_GAMES];
    return s.split(',').map(x=>x.trim()).filter(Boolean).filter(x => SUPPORTED_GAMES.includes(x));
  }
  const g = (qGame || DEFAULT_GAME).toString().toLowerCase();
  return SUPPORTED_GAMES.includes(g) ? [g] : [DEFAULT_GAME];
}

async function fetchJSON(url, { swid, s2, timeoutMs = 15000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = {
    'accept': 'application/json,text/plain,*/*',
    'user-agent': 'ff-platform-service/espn-ingest',
    ...(swid && s2 ? { cookie: `SWID=${encodeURIComponent(swid)}; espn_s2=${s2}` } : {})
  };
  const r = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow', cache: 'no-store' });
  clearTimeout(t);
  if (!r.ok) {
    const txt = await r.text().catch(()=>'');
    const e = new Error(`HTTP ${r.status} for ${url}`);
    e.status = r.status; e.body = txt;
    throw e;
  }
  return r.json();
}

function teamName(t) {
  const nm = [t.location, t.nickname].filter(Boolean).join(' ').trim();
  return nm || t.name || t.abbrev || `Team ${t.id}`;
}

function mapRecord(t) {
  const r = t.record || {};
  const overall = r.overall || r.regularSeason || r.total || {};
  const co = v => v == null ? undefined : v;
  return {
    overall: {
      wins: co(overall.wins), losses: co(overall.losses), ties: co(overall.ties),
      percentage: co(overall.percentage),
      pointsFor: co(overall.pointsFor), pointsAgainst: co(overall.pointsAgainst),
      streakType: co(overall.streakType), streakLength: co(overall.streakLength),
      gamesBack: co(overall.gamesBack)
    }
  };
}

function mapLeague(json, game) {
  return {
    platform: 'espn',
    game, // ffl, fba, flb, fhl
    leagueId: String(json.id ?? json.leagueId ?? ''),
    season: Number(json.seasonId ?? json.season ?? NaN),
    name: json.settings?.name || json.name || `ESPN ${game.toUpperCase()} League`,
    scoring: { type: json.settings?.scoringType || json.scoringType || 'H2H' },
    teams: Array.isArray(json.teams) ? json.teams.map(t => ({
      platform: 'espn',
      game,
      teamId: Number(t.id ?? t.teamId ?? NaN),
      name: teamName(t),
      owner: (Array.isArray(t.owners) && t.owners[0]) || null,
      record: mapRecord(t),
      logo: t.logo || t.logoUrl || null
    })) : [],
    meta: { draftComplete: !!json.draftDetail }
  };
}

/* ----------------------------- DB schema ----------------------------- */
// Base tables + evolve schema to include `game`
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_league (
      platform     TEXT NOT NULL,
      league_id    TEXT NOT NULL,
      season       INT  NOT NULL,
      name         TEXT,
      scoring_type TEXT,
      meta         JSONB,
      PRIMARY KEY (platform, league_id, season)
    );
    CREATE TABLE IF NOT EXISTS ff_team (
      platform   TEXT NOT NULL,
      league_id  TEXT NOT NULL,
      season     INT  NOT NULL,
      team_id    INT  NOT NULL,
      name       TEXT,
      owner      TEXT,
      logo       TEXT,
      record     JSONB,
      PRIMARY KEY (platform, league_id, season, team_id)
    );
    ALTER TABLE ff_league ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'ffl';
    ALTER TABLE ff_team   ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'ffl';
    CREATE INDEX IF NOT EXISTS ff_league_game_idx ON ff_league (platform, game, season);
    CREATE INDEX IF NOT EXISTS ff_team_game_idx   ON ff_team   (platform, game, season);
  `);
}

async function ensureCredsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_espn_cred (
      swid       TEXT PRIMARY KEY,
      s2         TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function upsertCred({ swid, s2 }) {
  await pool.query(`
    INSERT INTO ff_espn_cred (swid, s2, created_at, updated_at)
    VALUES ($1,$2, NOW(), NOW())
    ON CONFLICT (swid) DO UPDATE SET s2 = EXCLUDED.s2, updated_at = NOW()
  `, [swid, s2]);
}

async function upsertLeague(league) {
  await pool.query(`
    INSERT INTO ff_league (platform, league_id, season, name, scoring_type, meta, game)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (platform, league_id, season)
    DO UPDATE SET
      name = EXCLUDED.name,
      scoring_type = EXCLUDED.scoring_type,
      meta = EXCLUDED.meta,
      game = EXCLUDED.game
  `, [
    league.platform, String(league.leagueId), Number(league.season),
    league.name || null,
    league.scoring?.type || null,
    JSON.stringify({ scoring: league.scoring, meta: league.meta }),
    league.game
  ]);
}

async function upsertTeams(league) {
  const rows = (league.teams || []).map(t => ([
    league.platform,
    String(league.leagueId),
    Number(league.season),
    Number(t.teamId),
    t.name || null,
    t.owner || null,
    t.logo || null,
    JSON.stringify(t.record || {}),
    league.game
  ]));
  if (!rows.length) return 0;

  const values = rows.map((_,i)=> {
    const o=i*9; return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9})`;
  }).join(',');

  await pool.query(`
    INSERT INTO ff_team (platform, league_id, season, team_id, name, owner, logo, record, game)
    VALUES ${values}
    ON CONFLICT (platform, league_id, season, team_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      owner = EXCLUDED.owner,
      logo  = EXCLUDED.logo,
      record= EXCLUDED.record,
      game  = EXCLUDED.game
  `, rows.flat());
  return rows.length;
}

/* -------------------------- league discovery ------------------------- */
async function discoverSeason({ game, season, swid, s2 }) {
  const trace = [];
  const ids = new Set();

  // A) Fan API (primary)
  try {
    const u = `https://fan.api.espn.com/apis/v2/fantasy/users/${encodeURIComponent(swid)}/games/${game}?season=${season}`;
    const j = await fetchJSON(u, { swid, s2 });
    const arr = (j?.leagues || j?.items || []).map(x => String(x.id || x.leagueId)).filter(Boolean);
    arr.forEach(id => ids.add(id));
    trace.push({ source: 'fan_api', ok: true, count: arr.length });
  } catch (e) {
    trace.push({ source: 'fan_api', ok: false, status: e.status || null, error: e.message });
  }

  // B) lm-api-reads member→leagues (fallback)
  try {
    const u = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/members/${encodeURIComponent(swid)}/leagues?view=mTeam`;
    const j = await fetchJSON(u, { swid, s2 });
    const arr = Array.isArray(j) ? j.map(x => String(x.id)).filter(Boolean) : [];
    arr.forEach(id => ids.add(id));
    trace.push({ source: 'reads_member_leagues', ok: true, count: arr.length });
  } catch (e) {
    trace.push({ source: 'reads_member_leagues', ok: false, status: e.status || null, error: e.message });
  }

  return { ids: Array.from(ids), trace };
}

/* -------------------------------- routes ----------------------------- */

router.get('/status', (req, res) => {
  const { swid, s2 } = readCreds(req);
  res.set('Cache-Control','no-store');
  res.json({ ok: true, espn: { hasCookies: !!(swid && s2) }, ts: new Date().toISOString() });
});

// Debug discovery (no DB writes)
router.get('/discover', async (req, res) => {
  try {
    const seasons = parseSeasons(req.query.season, req.query.seasons);
    const games   = parseGames(req.query.game, req.query.games);
    const { swid, s2 } = readCreds(req);
    if (!(swid && s2)) return res.status(401).json({ ok:false, error:'auth_required' });

    const byGame = {};
    for (const game of games) {
      byGame[game] = {};
      for (const season of seasons) {
        byGame[game][season] = await discoverSeason({ game, season, swid, s2 });
      }
    }
    res.set('Cache-Control','no-store');
    res.json({ ok:true, games, seasons, byGame });
  } catch (e) {
    console.error('[espn/discover] error', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// Ingest (multi-game, multi-season)
router.get('/leagues', async (req, res) => {
  const start = Date.now();
  try {
    const seasons = parseSeasons(req.query.season, req.query.seasons);
    const games   = parseGames(req.query.game, req.query.games);

    const injectStr = String(req.query.inject || '').trim();
    // inject can be bare IDs (attach to first game/season) OR triplets "game:season:id"
    const injectTokens = injectStr ? injectStr.split(/[,\s]+/).filter(Boolean) : [];

    const { swid, s2 } = readCreds(req);
    if (!(swid && s2) && injectTokens.length === 0) {
      return res.status(401).json({ ok:false, error:'auth_required', message:'Send SWID/espn_s2 or use ?inject=' });
    }

    await ensureTables();

    // Discover per (game, season)
    const discovered = { games, seasons, byGame: {}, totalIds: 0 };
    const keys = new Set(); // key = `${game}:${season}:${leagueId}`

    for (const game of games) {
      discovered.byGame[game] = {};
      for (const season of seasons) {
        const d = (swid && s2) ? await discoverSeason({ game, season, swid, s2 }) : { ids: [], trace: [] };
        discovered.byGame[game][season] = d;
        d.ids.forEach(id => keys.add(`${game}:${season}:${id}`));
        discovered.totalIds += d.ids.length;
      }
    }

    // Parse injects
    for (const tok of injectTokens) {
      if (/^\d+$/.test(tok)) {
        keys.add(`${games[0]}:${seasons[0]}:${tok}`);
      } else {
        const m = /^([a-z]+):(\d{4}):(\d+)$/.exec(tok.toLowerCase());
        if (m && SUPPORTED_GAMES.includes(m[1])) keys.add(`${m[1]}:${m[2]}:${m[3]}`);
      }
    }

    const leagues = [];
    const errors  = [];

    for (const key of keys) {
      const [game, seasonStr, id] = key.split(':');
      const season = parseInt(seasonStr, 10);
      try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${id}?view=mTeam&view=mSettings`;
        const json = await fetchJSON(url, { swid, s2 });
        const L = mapLeague(json, game);
        await upsertLeague(L);
        await upsertTeams(L);
        leagues.push(L);
      } catch (e) {
        errors.push({ game, season, leagueId: id, status: e.status || null, error: e.message });
      }
    }

    res.set('Cache-Control','no-store');
    res.json({
      ok: true,
      games,
      seasons,
      discovered,
      leagues,
      errors,
      ms: Date.now() - start
    });
  } catch (e) {
    console.error('[espn/leagues] error', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// ---------- NEW: /api/espn/link ----------
// Usage: /api/espn/link?swid=%7B...%7D&s2=... [&games=all] [&season=2025|&seasons=2019-2025]
// Behavior: sets cookies, upserts ff_espn_cred, ingests, then 302 -> /fein
router.get('/link', async (req, res) => {
  try {
    // 1) validate creds from query
    let swid = req.query.swid ? decodeURIComponent(String(req.query.swid)) : '';
    let s2   = req.query.s2   ? String(req.query.s2) : '';
    if (!swid || !s2) return res.status(400).send('missing swid or s2');

    if (!/^\{.*\}$/.test(swid)) swid = `{${swid.replace(/^\{?|\}?$/g,'')}}`;

    // 2) persist creds
    await ensureCredsTable();
    await upsertCred({ swid, s2 });

    // 3) set cookies for subsequent calls
    const secure = process.env.NODE_ENV === 'production';
    const oneYear = 1000 * 60 * 60 * 24 * 365;

    // httpOnly for real auth cookies (server reads them)
    res.cookie('SWID', swid,         { httpOnly: true, sameSite: 'Lax', secure, maxAge: oneYear, path: '/' });
    res.cookie('espn_s2', s2,        { httpOnly: true, sameSite: 'Lax', secure, maxAge: oneYear, path: '/' });

    // non-httpOnly flag for frontend bootstrap
    res.cookie('fein_has_espn', '1', { httpOnly: false, sameSite: 'Lax', secure, maxAge: 60*60*24*90*1000, path: '/' });

    // also set ff_* fallbacks some codepaths check
    res.cookie('ff_espn_swid', swid, { httpOnly: true, sameSite: 'Lax', secure, maxAge: oneYear, path: '/' });
    res.cookie('ff_espn_s2',   s2,   { httpOnly: true, sameSite: 'Lax', secure, maxAge: oneYear, path: '/' });

    // 4) run ingest (defaults: games=all, current season)
    const seasons = parseSeasons(req.query.season, req.query.seasons);
    const games   = parseGames(req.query.game, req.query.games || 'all');

    await ensureTables();

    const discovered = { games, seasons, byGame: {}, totalIds: 0 };
    const keys = new Set();

    for (const game of games) {
      discovered.byGame[game] = {};
      for (const season of seasons) {
        const d = await discoverSeason({ game, season, swid, s2 });
        discovered.byGame[game][season] = d;
        d.ids.forEach(id => keys.add(`${game}:${season}:${id}`));
        discovered.totalIds += d.ids.length;
      }
    }

    let leaguesIngested = 0;
    let teamsIngested   = 0;

    for (const key of keys) {
      const [game, seasonStr, id] = key.split(':');
      const season = parseInt(seasonStr, 10);
      try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${id}?view=mTeam&view=mSettings`;
        const json = await fetchJSON(url, { swid, s2 });
        const L = mapLeague(json, game);
        await upsertLeague(L);
        leaguesIngested++;
        teamsIngested += await upsertTeams(L);
      } catch (e) {
        // continue; we redirect regardless
        console.warn('[espn/link] league ingest failed', { game, season, id, msg: e.message });
      }
    }

    // 5) redirect to /fein (include tiny summary in query)
    const summary = new URLSearchParams({
      linked: '1',
      leagues: String(leaguesIngested),
      teams: String(teamsIngested)
    }).toString();

    res.redirect(302, `/fein?${summary}`);
  } catch (e) {
    console.error('[espn/link] error', e);
    res.status(500).send('link_failed');
  }
});

module.exports = router;
