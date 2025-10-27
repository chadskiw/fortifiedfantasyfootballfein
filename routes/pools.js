'use strict';

// routes/pools.preview.js (hardened)
// POST /api/pools/preview
// Body: { season, weeks[], teamIds[], leagueIds[], scoring[] }
// Notes:
//  - Zips leagueIds[] and teamIds[] 1:1 (no cross product)
//  - Detects ff_pools points column name dynamically
//  - Casts league_id to text for safe joins
//  - Extra-safe pool import with multi-path fallback

const express = require('express');
const router = express.Router();

// --- Robust pg Pool import (multi-path fallback) ---
let pgPool;
(function resolvePool(){
  const candidates = [
    '../src/db/pool' // common in your repo

  ];
  let lastErr;
  for(const p of candidates){
    try{
      const mod = require(p);
      pgPool = mod.pool || mod; // allow { pool } or default export
      if(pgPool) return;
    }catch(e){ lastErr = e; }
  }
  throw new Error('Unable to load a pg Pool from known paths. Last error: '+(lastErr?.message||'unknown'));
})();

// --- Helpers ---
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

// --- Route ---
router.post('/preview', express.json(), async (req, res) => {
  const client = await pgPool.connect();
  try {
    const p = normalizePayload(req.body);
    const err = validatePayload(p);
    if (err) return res.status(400).json({ error: err });

    const pointsCol = await detectPointsColumn(client);

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
    return res.json({ ok:true, rows: r.rows, count: r.rowCount, pointsColumn: pointsCol });
  } catch (e) {
    // Bubble the message so the UI can show why it failed
    return res.status(500).json({ ok:false, error: e.message });
  } finally {
    client.release();
  }
});

// Optional: a quick health check to debug 500s without payload
router.get('/preview/health', async (req,res)=>{
  const client = await pgPool.connect();
  try{
    const pointsCol = await detectPointsColumn(client);
    res.json({ ok:true, pointsColumn: pointsCol });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  finally{ client.release(); }
});

module.exports = router;
