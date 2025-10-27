'use strict';

// routes/pools.preview.js
// Implements POST /api/pools/preview
// - Accepts { season, weeks[], teamIds[], leagueIds[], scoring[] }
// - Returns comparison rows joining ff_team_weekly_points → ff_pools
// - Robust to ff_pools points column name (points|score|total_points)
// - Zips leagueIds[] and teamIds[] 1:1 to avoid cross-products

const express = require('express');
const router = express.Router();

// Reuse your existing pg pool from pool.js
// (supports both module.exports = pool and { pool })
let pgPool;
try {
  const mod = require('../src/db/pool');
  pgPool = mod.pool || mod; // prefer named export "pool"
} catch (e) {
  throw new Error('Failed to require ../pool (pg Pool). Make sure pool.js exports a Pool instance.');
}

async function hasColumn(client, table, col) {
  const q = `SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`;
  const r = await client.query(q, [table, col]);
  return r.rowCount > 0;
}

async function detectPointsColumn(client) {
  if (await hasColumn(client, 'ff_pools', 'points')) return 'points';
  if (await hasColumn(client, 'ff_pools', 'score')) return 'score';
  if (await hasColumn(client, 'ff_pools', 'total_points')) return 'total_points';
  throw new Error("ff_pools is missing a points column (expected 'points', 'score', or 'total_points').");
}

function normalizePayload(body) {
  const season = Number(body?.season);
  const weeks = (Array.isArray(body?.weeks) ? body.weeks : []).map(n => Number(n)).filter(Number.isFinite);
  const teamIds = (Array.isArray(body?.teamIds) ? body.teamIds : []).map(n => Number(n)).filter(Number.isFinite);
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

router.post('/preview', express.json(), async (req, res) => {
  const client = await pgPool.connect();
  try {
    const p = normalizePayload(req.body);
    const err = validatePayload(p);
    if (err) return res.status(400).json({ error: err });

    const pointsCol = await detectPointsColumn(client);

    // Build and run preview query
    const sql = `
      WITH pairs AS (
        SELECT * FROM unnest($2::text[], $3::int[]) AS s(league_id, team_id)
      ), t AS (
        SELECT season, league_id::text AS league_id, team_id, week, scoring, points AS team_points
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
      )
      SELECT t.season, t.league_id, t.team_id, f.team_name, t.week, t.scoring, t.team_points,
             p."${pointsCol}" AS pool_points
      FROM t
      JOIN pairs s ON s.league_id=t.league_id AND s.team_id=t.team_id
      LEFT JOIN ff_pools p
        ON p.season=t.season AND p.week=t.week AND p.team_id=t.team_id
       AND p.scoring=t.scoring AND p.league_id::text=t.league_id
      LEFT JOIN ff_sport_ffl f
        ON f.season=t.season AND f.team_id=t.team_id AND f.league_id::text=t.league_id
      ORDER BY t.week, t.league_id, t.team_id, t.scoring`;

    const params = [
      p.season,
      p.leagueIds.map(String),
      p.teamIds,
      p.weeks,
      p.scoring
    ];

    const r = await client.query(sql, params);
    return res.json({ rows: r.rows, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

/*
=====================================================
Mount in server.js
-----------------------------------------------------


=====================================================
Manual tests (curl)
-----------------------------------------------------
# 1) Basic preview for a single (leagueId, teamId) pair and weeks 1-3
curl -sS -X POST http://localhost:3000/api/pools/preview \
  -H 'Content-Type: application/json' \
  -d '{
        "season": 2025,
        "weeks": [1,2,3],
        "scoring": ["STD","HALF","PPR"],
        "leagueIds": ["1634950747"],
        "teamIds": [7]
      }' | jq '.'

# 2) Multiple paired teams across leagues (index-aligned)
curl -sS -X POST http://localhost:3000/api/pools/preview \
  -H 'Content-Type: application/json' \
  -d '{
        "season": 2025,
        "weeks": [1,2,3,4],
        "scoring": ["PPR"],
        "leagueIds": ["1634950747","1888700373"],
        "teamIds": [7,4]
      }' | jq '.'

# 3) Error case: mismatched array lengths
curl -sS -X POST http://localhost:3000/api/pools/preview \
  -H 'Content-Type: application/json' \
  -d '{
        "season": 2025,
        "weeks": [1],
        "scoring": ["PPR"],
        "leagueIds": ["1634950747"],
        "teamIds": [7,4]
      }' | jq '.'
*/
