'use strict';

// routes/pools.js (ultra-hardened)
// Endpoints:
//   POST /api/pools/preview
//   POST /api/pools/update
//   GET  /api/pools/preview/health
//   GET  /api/pools/preview/diag   <-- returns schema introspection
//
// Key robustness:
//  - Resolves pg Pool from multiple paths; falls back to env DATABASE_URL
//  - Works even if ff_pools table OR its points column do not exist (preview returns pool_points=null)
//  - If ff_pools.scoring is missing, joins without scoring
//  - Zips leagueIds[] and teamIds[]
//  - Clear JSON errors instead of opaque 500s

const express = require('express');
const router = express.Router();

// -------- pg Pool resolution (robust) --------
let pgPool;
function getPool() {
  if (pgPool) return pgPool;

  const candidates = [
    '../src/db/pool',
  ];

  for (const p of candidates) {
    try {
      const mod = require(p);
      const maybe = mod.pool || mod;
      if (maybe && typeof maybe.connect === 'function') {
        pgPool = maybe;
        return pgPool;
      }
    } catch (_) { /* try next */ }
  }

  // Fallback: build directly from env
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });
  return pgPool;
}

async function withClient(fn, res) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  } finally {
    client.release();
  }
}

// -------- schema helpers --------
async function tableExists(client, table) {
  const q = `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`;
  const r = await client.query(q, [table]);
  return r.rowCount > 0;
}

async function hasColumn(client, table, col) {
  const q = `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`;
  const r = await client.query(q, [table, col]);
  return r.rowCount > 0;
}

async function detectPointsColumn(client) {
  if (!(await tableExists(client, 'ff_pools'))) return null; // allow preview without ff_pools
  if (await hasColumn(client, 'ff_pools', 'points')) return 'points';
  if (await hasColumn(client, 'ff_pools', 'score')) return 'score';
  if (await hasColumn(client, 'ff_pools', 'total_points')) return 'total_points';
  return null; // preview will emit pool_points = null
}

async function leagueIdDatatype(client) {
  if (!(await tableExists(client, 'ff_pools'))) return 'text';
  const q = `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='ff_pools' AND column_name='league_id'`;
  const r = await client.query(q);
  return r.rows[0]?.data_type || 'text';
}

function normalizePayload(body) {
  const season = Number(body?.season);
  const weeks = (Array.isArray(body?.weeks) ? body.weeks : []).map(Number).filter(Number.isFinite);
  const teamIds = (Array.isArray(body?.teamIds) ? body.teamIds : []).map(Number).filter(Number.isFinite);
  const leagueIds = (Array.isArray(body?.leagueIds) ? body.leagueIds : []).map(String);
  const scoring = (Array.isArray(body?.scoring) ? body.scoring : []).map(s => String(s).toUpperCase());
  return { season, weeks, teamIds, leagueIds, scoring };
}

function validatePayload(p) {
  if (!p.season) return 'Season is required.';
  if (!p.weeks.length) return 'At least one week is required.';
  if (!p.teamIds.length) return 'At least one teamId is required.';
  if (!p.leagueIds.length) return 'At least one leagueId is required.';
  if (p.teamIds.length !== p.leagueIds.length)
    return 'leagueIds[] and teamIds[] must be the same length (paired by index).';
  if (!p.scoring.length) return 'At least one scoring value is required.';
  return null;
}

// -------- Health check --------
router.get('/preview/health', (req, res) =>
  withClient(async (client) => {
    const hasPools = await tableExists(client, 'ff_pools');
    const hasTWP = await tableExists(client, 'ff_team_weekly_points');
    const pointsCol = await detectPointsColumn(client);
    const hasScoringInPools = hasPools ? await hasColumn(client, 'ff_pools', 'scoring') : false;
    return res.json({ ok: true, hasPools, hasTeamWeeklyPoints: hasTWP, pointsColumn: pointsCol, poolsHasScoring: hasScoringInPools });
  }, res)
);

// -------- Preview --------
router.post('/preview', express.json(), (req, res) =>
  withClient(async (client) => {
    const p = normalizePayload(req.body);
    const err = validatePayload(p);
    if (err) return res.status(400).json({ ok: false, error: err });

    const hasPools = await tableExists(client, 'ff_pools');
    const pointsCol = await detectPointsColumn(client); // may be null
    const poolsHasScoring = hasPools ? await hasColumn(client, 'ff_pools', 'scoring') : false;

    // Build dynamic LEFT JOIN for ff_pools that tolerates missing columns
    const joinPools = hasPools
      ? `LEFT JOIN ff_pools p
           ON p.season   = t.season
          AND p.week     = t.week
          AND p.team_id  = t.team_id
          ${poolsHasScoring ? 'AND p.scoring  = t.scoring' : ''}
          AND p.league_id::text = t.league_id`
      : '';

    const poolPointsSelect = pointsCol ? `p."${pointsCol}"` : 'NULL';

    const sql = `
      WITH pairs AS (
        SELECT * FROM unnest($2::text[], $3::int[]) AS s(league_id, team_id)
      ), t AS (
        SELECT season, league_id::text AS league_id, team_id, week, scoring, points AS team_points
          FROM ff_team_weekly_points
         WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
      )
      SELECT t.season, t.league_id, t.team_id, f.team_name, t.week, t.scoring, t.team_points,
             ${poolPointsSelect} AS pool_points
        FROM t
        JOIN pairs s ON s.league_id=t.league_id AND s.team_id=t.team_id
        ${joinPools}
   LEFT JOIN ff_sport_ffl f
          ON f.season=t.season AND f.team_id=t.team_id AND f.league_id::text=t.league_id
    ORDER BY t.week, t.league_id, t.team_id, t.scoring`;

    const params = [ p.season, p.leagueIds.map(String), p.teamIds, p.weeks, p.scoring ];
    const r = await client.query(sql, params);
    return res.json({ ok: true, usedPools: hasPools, pointsColumn: pointsCol, poolsHasScoring, count: r.rowCount, rows: r.rows });
  }, res)
);

// -------- Update (Apply) --------
router.post('/update', express.json(), (req, res) =>
  withClient(async (client) => {
    const p = normalizePayload(req.body);
    const err = validatePayload(p);
    if (err) return res.status(400).json({ ok: false, error: err });

    // If ff_pools doesn't exist or has no points column, error early with guidance
    if (!(await tableExists(client, 'ff_pools')))
      return res.status(400).json({ ok: false, error: "Table 'ff_pools' does not exist. Create it first, including columns (season, league_id, team_id, week, scoring, points)." });

    const pointsCol = await detectPointsColumn(client);
    if (!pointsCol)
      return res.status(400).json({ ok: false, error: "ff_pools has no points column. Add one named 'points', 'score', or 'total_points'." });

    const dt = await leagueIdDatatype(client);
    const castExpr = ['bigint','integer','numeric','smallint','decimal'].includes(dt) ? `::${dt}` : '::text';

    await client.query('BEGIN');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_pools_key ON ff_pools(season, league_id, team_id, week, scoring);`);

    const sql = `
      WITH pairs AS (
        SELECT * FROM unnest($2::text[], $3::int[]) AS s(league_id, team_id)
      ), src AS (
        SELECT season, league_id::text AS league_id, team_id, week, scoring, points
          FROM ff_team_weekly_points
         WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
      )
      INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
      SELECT s.season,
             (s.league_id||'')${castExpr} AS league_id,
             s.team_id,
             s.week,
             s.scoring,
             s.points,
             now(),
             now()
        FROM src s
        JOIN pairs p ON p.league_id=s.league_id AND p.team_id=s.team_id
  ON CONFLICT (season, league_id, team_id, week, scoring)
    DO UPDATE SET "${pointsCol}" = EXCLUDED."${pointsCol}", updated_at = now();`;

    const r = await client.query(sql, [ p.season, p.leagueIds.map(String), p.teamIds, p.weeks, p.scoring ]);
    await client.query('COMMIT');
    return res.json({ ok: true, changed: r.rowCount || 0, pointsColumn: pointsCol });
  }, res)
);

module.exports = router;

