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
router.post('/preview', express.json(), async (req,res)=>{
  try{
    const {season, weeks, teamIds, leagueIds, scoring} = req.body||{};
    if(!season || !Array.isArray(weeks) || !weeks.length ||
       !Array.isArray(teamIds) || !teamIds.length ||
       !Array.isArray(leagueIds) || leagueIds.length !== teamIds.length ||
       !Array.isArray(scoring) || !scoring.length){
      return res.status(400).json({error:'Season, weeks[], scoring[], and matching leagueIds[] and teamIds[] are required.'});
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
      t AS (
        SELECT season,
               league_id::text AS league_id,
               team_id::text   AS team_id,
               week, scoring, points AS team_points
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
      )
      SELECT t.season, t.league_id, t.team_id, f.team_name, t.week, t.scoring, t.team_points,
             p."${pointsCol}" AS pool_points
      FROM t
      JOIN pairs s ON s.league_id=t.league_id AND s.team_id=t.team_id
      LEFT JOIN ff_pools p
        ON p.season=t.season AND p.week=t.week
       AND p.scoring=t.scoring
       AND p.league_id::text=t.league_id
       AND p.team_id::text  =t.team_id
      LEFT JOIN ff_sport_ffl f
        ON f.season=t.season AND f.league_id::text=t.league_id AND f.team_id::text=t.team_id
      ORDER BY t.week, t.league_id, t.team_id, t.scoring`;
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
      return res.status(400).json({error:'Season, weeks[], scoring[], and matching leagueIds[] and teamIds[] are required.'});
    }
    const pointsCol = (await hasColumn('ff_pools','points')) ? 'points'
                    : (await hasColumn('ff_pools','score')) ? 'score'
                    : (await hasColumn('ff_pools','total_points')) ? 'total_points'
                    : null;
    if(!pointsCol) return res.status(500).json({error:"ff_pools missing points column ('points' | 'score' | 'total_points')."});

    // compute casts for league_id & team_id based on ff_pools schema
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
      src AS (
        SELECT season, league_id::text AS league_id, team_id::text AS team_id, week, scoring, points
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
      )
      INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
      SELECT s.season,
             (s.league_id||'')${lidCast},
             (s.team_id||'')${tidCast},
             s.week, s.scoring, s.points, now(), now()
      FROM src s
      JOIN pairs p ON p.league_id=s.league_id AND p.team_id=s.team_id
      ON CONFLICT (season, league_id, team_id, week, scoring)
      DO UPDATE SET "${pointsCol}" = EXCLUDED."${pointsCol}", updated_at = now();`;
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
