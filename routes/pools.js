// routes/pools.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized:false } : false });

// --- helpers ---
async function hasColumn(table, col){
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, col]
  );
  return r.rowCount > 0;
}
async function getType(table, col){
  const r = await pool.query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, col]
  );
  return r.rows[0]?.data_type || 'text';
}

// GET /api/pools/teams?season=2025
router.get('/teams', async (req,res)=>{
  try{
    const { season } = req.query;
    if(!season) return res.status(400).json({error:'Season is required.'});
    const q = `
      SELECT DISTINCT season, league_id::text AS league_id, team_id::text AS team_id, team_name
      FROM ff_sport_ffl
      WHERE season=$1
      ORDER BY league_id, team_id`;
    const r = await pool.query(q, [season]);
    res.json({ teams: r.rows.map(x=>({ league_id:x.league_id, team_id:x.team_id, team_name:x.team_name })) });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// POST /api/pools/preview { season, weeks[], teamIds[], leagueIds[], scoring[] }
// POST /api/pools/preview { season, weeks[], teamIds[], leagueIds[], scoring[] }
router.post('/preview', express.json(), async (req,res)=>{
  try{
    const {season, weeks, teamIds, leagueIds, scoring} = req.body||{};
    if(!season || !Array.isArray(weeks) || !weeks.length ||
       !Array.isArray(teamIds) || !teamIds.length ||
       !Array.isArray(leagueIds) || leagueIds.length !== teamIds.length ||
       !Array.isArray(scoring) || !scoring.length){
      return res.status(400).json({error:'season, weeks[], scoring[], and matching leagueIds[] & teamIds[] are required.'});
    }

    const pointsCol = (await hasColumn('ff_pools','points')) ? 'points'
                    : (await hasColumn('ff_pools','score')) ? 'score'
                    : (await hasColumn('ff_pools','total_points')) ? 'total_points'
                    : null;
    if(!pointsCol) return res.status(500).json({error:"ff_pools missing points column ('points' | 'score' | 'total_points')."});

    const q = `
      WITH pairs AS (
        SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
      ),
      scor(scoring) AS (SELECT unnest($5::text[])),
      -- Primary source: ff_team_weekly_points (already computed)
      t_week AS (
        SELECT season,
               league_id::text AS league_id,
               team_id::text   AS team_id,
               week,
               UPPER(scoring)  AS scoring,
               points::numeric AS points,
               1 AS pri
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND UPPER(scoring) = ANY($5)
      ),
      -- Fallback source: ff_team_points_cache (derive per requested scoring)
      t_cache AS (
        SELECT c.season,
               (c.league_id)::text AS league_id,
               (c.team_id)::text   AS team_id,
               c.week,
               UPPER(s.scoring)    AS scoring,
               COALESCE(
                 CASE WHEN UPPER(s.scoring)='PPR'  THEN ff_safe_to_numeric(to_jsonb(c)->>'ppr_points') END,
                 CASE WHEN UPPER(s.scoring)='PPR'  THEN ff_safe_to_numeric(to_jsonb(c)->>'ppr') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half_points') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half_ppr') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'std_points') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'standard_points') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'std') END,
                 ff_safe_to_numeric(to_jsonb(c)->>'points')
               )::numeric AS points,
               2 AS pri
        FROM ff_team_points_cache c
        JOIN scor s ON TRUE
        WHERE c.season=$1 AND c.week = ANY($4)
      ),
      all_src AS (
        SELECT * FROM t_week
        UNION ALL
        SELECT * FROM t_cache
      ),
      ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY season, league_id, team_id, week, scoring ORDER BY pri) AS rn
        FROM all_src
      )
      SELECT a.season, a.league_id, a.team_id, f.team_name, a.week, a.scoring,
             a.points AS team_points, p."${pointsCol}" AS pool_points
      FROM ranked a
      JOIN pairs s ON s.league_id=a.league_id AND s.team_id=a.team_id
      LEFT JOIN ff_pools p
        ON p.season=a.season AND p.week=a.week
       AND UPPER(p.scoring)=a.scoring
       AND p.league_id::text=a.league_id
       AND p.team_id::text  =a.team_id
      LEFT JOIN ff_sport_ffl f
        ON f.season=a.season AND f.league_id::text=a.league_id AND f.team_id::text=a.team_id
      WHERE a.rn=1
      ORDER BY a.week, a.league_id, a.team_id, a.scoring`;

    const r = await pool.query(q, [
      season,
      leagueIds.map(String),
      teamIds.map(String),
      weeks,
      scoring.map(s=>String(s).toUpperCase())
    ]);
    res.json({rows:r.rows});
  }catch(e){ res.status(500).json({error:e.message, stack:e.stack}); }
});

// POST /api/pools/update { season, weeks[], teamIds[], leagueIds[], scoring[] }
router.post('/update', express.json(), async (req,res)=>{
  const client = await pool.connect();
  try{
    const {season, weeks, teamIds, leagueIds, scoring} = req.body||{};
    if(!season || !Array.isArray(weeks) || !weeks.length ||
       !Array.isArray(teamIds) || !teamIds.length ||
       !Array.isArray(leagueIds) || leagueIds.length !== teamIds.length ||
       !Array.isArray(scoring) || !scoring.length){
      return res.status(400).json({error:'season, weeks[], scoring[], and matching leagueIds[] & teamIds[] are required.'});
    }

    const pointsCol = (await hasColumn('ff_pools','points')) ? 'points'
                    : (await hasColumn('ff_pools','score')) ? 'score'
                    : (await hasColumn('ff_pools','total_points')) ? 'total_points'
                    : null;
    if(!pointsCol) return res.status(500).json({error:"ff_pools missing points column ('points' | 'score' | 'total_points')."});

    const lidType = await getType('ff_pools','league_id');
    const tidType = await getType('ff_pools','team_id');
    const lidCast = ['bigint','integer','numeric','smallint','decimal'].includes(lidType) ? `::${lidType}` : '::text';
    const tidCast = ['bigint','integer','numeric','smallint','decimal'].includes(tidType) ? `::${tidType}` : '::text';

    await client.query('BEGIN');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_pools_key ON ff_pools(season, league_id, team_id, week, scoring);`);

    const q = `
      WITH pairs AS (
        SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
      ),
      scor(scoring) AS (SELECT unnest($5::text[])),
      t_week AS (
        SELECT season, league_id::text AS league_id, team_id::text AS team_id,
               week, UPPER(scoring) AS scoring, points::numeric AS points, 1 AS pri
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND UPPER(scoring) = ANY($5)
      ),
      t_cache AS (
        SELECT c.season, (c.league_id)::text AS league_id, (c.team_id)::text AS team_id,
               c.week, UPPER(s.scoring) AS scoring,
               COALESCE(
                 CASE WHEN UPPER(s.scoring)='PPR'  THEN ff_safe_to_numeric(to_jsonb(c)->>'ppr_points') END,
                 CASE WHEN UPPER(s.scoring)='PPR'  THEN ff_safe_to_numeric(to_jsonb(c)->>'ppr') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half_points') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half_ppr') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'std_points') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'standard_points') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'std') END,
                 ff_safe_to_numeric(to_jsonb(c)->>'points')
               )::numeric AS points,
               2 AS pri
        FROM ff_team_points_cache c
        JOIN scor s ON TRUE
        WHERE c.season=$1 AND c.week = ANY($4)
      ),
      all_src AS (SELECT * FROM t_week UNION ALL SELECT * FROM t_cache),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY season, league_id, team_id, week, scoring ORDER BY pri) AS rn
        FROM all_src
      )
      INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
      SELECT a.season,
             (a.league_id||'')${lidCast},
             (a.team_id||'')${tidCast},
             a.week, a.scoring, a.points, now(), now()
      FROM ranked a
      JOIN pairs p ON p.league_id=a.league_id AND p.team_id=a.team_id
      WHERE a.rn=1
      ON CONFLICT (season, league_id, team_id, week, scoring)
      DO UPDATE SET "${pointsCol}"=EXCLUDED."${pointsCol}", updated_at=now();`;

    const r = await client.query(q, [
      season,
      leagueIds.map(String),
      teamIds.map(String),
      weeks,
      scoring.map(s=>String(s).toUpperCase())
    ]);
    await client.query('COMMIT');
    res.json({ ok:true, upserted: r.rowCount||0 });
  }catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({ok:false, error:e.message, stack:e.stack});
  } finally { client.release(); }
});

module.exports = router;
