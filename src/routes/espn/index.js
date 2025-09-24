// src/routes/espn/index.js
// ESPN API (no HTML). Creates/updates DB rows for leagues/teams.
// Endpoints:
//   GET /api/espn/status
//   GET /api/espn/login
//   GET /api/espn/leagues?season=2025&inject=1888700373,12345678
//
// Reads creds from cookies SWID/espn_s2, or headers x-espn-swid/x-espn-s2,
// or TEST_ESPN_SWID / TEST_ESPN_S2 env vars (dev).
//
// DB tables auto-created:
//   ff_league(platform, league_id, season, name, scoring_type, created_at, updated_at)
//   ff_team  (platform, league_id, season, team_id, name, owner_guid, logo, record, updated_at)

const express = require('express');
const router  = express.Router();
const { normalizeLeague } = require('./normalize');
const pool = require('../../db/pool'); // pg.Pool instance

// ---------- creds helpers ----------
function readEspnCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};

  let swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || process.env.TEST_ESPN_SWID || null;
  let s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2']   || process.env.TEST_ESPN_S2   || null;

  if (swid && !/^\{.*\}$/.test(decodeURIComponent(String(swid)))) {
    const d = decodeURIComponent(String(swid));
    swid = d.startsWith('{') ? d : `{${d.replace(/^\{?|\}?$/g,'')}}`;
  } else if (swid) {
    swid = decodeURIComponent(String(swid));
  }
  return { swid, s2 };
}

function buildCookieHeader({ swid, s2 }) {
  if (!swid || !s2) return null;
  return `SWID=${encodeURIComponent(swid)}; espn_s2=${s2}`;
}

// ---------- ESPN fetch ----------
async function espnFetchJson(url, cookie) {
  const res = await fetch(url, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'cache-control': 'no-cache',
      ...(cookie ? { cookie } : {}),
      'user-agent': 'FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    const err = new Error(`ESPN ${res.status} ${res.statusText} for ${url}`);
    err.status = res.status; err.body = t;
    throw err;
  }
  return res.json();
}

async function fetchLeagueRaw({ season, leagueId, cookie }) {
  const qs = 'view=mTeam&view=mSettings';
  const urls = [
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`,
    `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`,
  ];
  let lastErr = null;
  for (const u of urls) {
    try { return await espnFetchJson(u, cookie); } catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('league_fetch_failed');
}

// ---------- DB helpers ----------
async function ensureIngestTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_league (
      platform      TEXT    NOT NULL,              -- e.g. 'espn'
      league_id     TEXT    NOT NULL,
      season        INTEGER NOT NULL,
      name          TEXT,
      scoring_type  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, league_id, season)
    );

    CREATE TABLE IF NOT EXISTS ff_team (
      platform      TEXT    NOT NULL,
      league_id     TEXT    NOT NULL,
      season        INTEGER NOT NULL,
      team_id       INTEGER NOT NULL,
      name          TEXT,
      owner_guid    TEXT,
      logo          TEXT,
      record        JSONB,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, league_id, season, team_id),
      FOREIGN KEY (platform, league_id, season)
        REFERENCES ff_league(platform, league_id, season)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS ff_team_league_idx
      ON ff_team (platform, league_id, season);

    CREATE INDEX IF NOT EXISTS ff_team_owner_idx
      ON ff_team (owner_guid);
  `);
}

async function upsertLeague({ platform, league }) {
  await pool.query(`
    INSERT INTO ff_league (platform, league_id, season, name, scoring_type, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
    ON CONFLICT (platform, league_id, season)
    DO UPDATE SET
      name = EXCLUDED.name,
      scoring_type = EXCLUDED.scoring_type,
      updated_at = NOW()
  `, [
    platform,
    String(league.leagueId),
    Number(league.season),
    league.name || null,
    league.scoring?.type || null,
  ]);
}

async function upsertTeams({ platform, league }) {
  const rows = (league.teams || []).map(t => ([
    platform,
    String(league.leagueId),
    Number(league.season),
    Number(t.teamId),
    t.name || null,
    t.owner || null,
    t.logo || null,
    t.record ? JSON.stringify(t.record) : null,
  ]));

  if (rows.length === 0) return 0;

  const valuesSql = rows.map((_, i) => {
    const o = i*8;
    return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8})`;
  }).join(',');

  const flat = rows.flat();

  const q = `
    INSERT INTO ff_team (platform, league_id, season, team_id, name, owner_guid, logo, record, updated_at)
    VALUES ${valuesSql}
    ON CONFLICT (platform, league_id, season, team_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      owner_guid = EXCLUDED.owner_guid,
      logo = EXCLUDED.logo,
      record = EXCLUDED.record,
      updated_at = NOW()
  `;
  await pool.query(q, flat);
  return rows.length;
}

// ---------- routes ----------
router.get('/status', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  res.set('Cache-Control','no-store');
  res.json({ ok: true, hasEspnCookies: !!(swid && s2) });
});

router.get('/login', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  res.set('Cache-Control','no-store');
  if (swid && s2) return res.json({ ok: true, step: 'logged_in' });
  return res.json({ ok: true, step: 'link_needed' });
});

router.get('/leagues', async (req, res) => {
  const season = parseInt(req.query.season, 10) || new Date().getFullYear();
  const inject = String(req.query.inject || '').trim();
  const { swid, s2 } = readEspnCreds(req);
  const cookie = buildCookieHeader({ swid, s2 });

  res.set('Cache-Control','no-store');

  try {
    await ensureIngestTables();

    if (!cookie) {
      return res.json({ ok: true, season, leagues: [], db: { upserted: 0, teams: 0 }, message: 'missing_espn_creds' });
    }

    const leagueIds = inject
      ? inject.split(/[,\s]+/).map(x => x.replace(/[^\d]/g,'')).filter(Boolean)
      : [];

    if (leagueIds.length === 0) {
      return res.json({ ok: true, season, leagues: [], db: { upserted: 0, teams: 0 }, message: 'no_inject_ids' });
    }

    const platform = 'espn';
    let upsertedLeagues = 0;
    let upsertedTeams   = 0;
    const out = [];

    for (const id of leagueIds) {
      try {
        const raw  = await fetchLeagueRaw({ season, leagueId: id, cookie });
        const norm = normalizeLeague(raw);
        if (!norm) continue;

        await upsertLeague({ platform, league: norm });
        upsertedLeagues += 1;

        const nTeams = await upsertTeams({ platform, league: norm });
        upsertedTeams += nTeams;

        out.push(norm);
      } catch (e) {
        console.error('[espn/leagues] fetch/upsert failed', id, e.message);
      }
    }

    return res.json({
      ok: true,
      season,
      leagues: out,
      db: { upserted: upsertedLeagues, teams: upsertedTeams }
    });
  } catch (e) {
    console.error('[espn/leagues] error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
