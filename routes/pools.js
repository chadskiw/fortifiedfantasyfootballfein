// routes/pools.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized:false } : false });
// node >=18 has global fetch; otherwise: const { fetch } = require('undici');
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://fortifiedfantasy.com';

// Sum starters from ESPN roster and surface starter detail
async function deriveFromEspnRoster({ season, week, leagueId, teamId }) {
  const u = new URL('/api/platforms/espn/roster', PUBLIC_BASE);
  u.searchParams.set('season', String(season));
  u.searchParams.set('week',   String(week));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('teamId',   String(teamId));

  const res = await fetch(u, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ESPN roster fetch ${res.status} ${res.statusText}`);
  const j = await res.json();

  const players = j?.players || j?.roster || [];
  if (!Array.isArray(players)) return null;

  let total = 0;
  const starters = [];
  for (const p of players) {
    // starter detection (robust to several shapes)
    const slot = (p.slot || p.lineupSlot || p.lineup || '').toString().toUpperCase();
    const slotId = Number(p.lineupSlotId);
    const isStarter =
      p.isStarter === true ||
      (slot && !['BN','BENCH','IR','OUT','INJURED_RESERVE'].includes(slot)) ||
      (Number.isFinite(slotId) && ![20,21,22,23,24,25,26].includes(slotId)); // common bench/IR ids

    const ap = Number(p.appliedPoints ?? p.applied_points ?? p.points ?? p.fp ?? p.actual ?? 0);
    if (!isStarter || !Number.isFinite(ap)) continue;

    total += ap;

    const rawId = p.id ?? p.playerId ?? p.player_id ?? p.player?.id ?? p.player?.playerId ?? p.athleteId ?? p.player?.athleteId;
    const numericId = Number(rawId);
    const starterId = Number.isFinite(numericId) ? numericId : rawId != null ? String(rawId) : null;
    const starterName = [
      p.name,
      p.player?.fullName,
      p.player?.name,
      p.player?.displayName,
      p.fullName,
      p.nickname
    ].find(v => typeof v === 'string' && v.trim().length) || null;
    const teamCode = [
      p.teamAbbrev,
      p.team,
      p.proTeam,
      p.proTeamAbbrev,
      p.player?.proTeamAbbreviation,
      p.player?.proTeam
    ].find(v => typeof v === 'string' && v.trim().length);
    const positionCode = [
      p.position,
      p.pos,
      p.player?.defaultPosition,
      p.player?.position,
      p.player?.defaultPositionAbbreviation
    ].find(v => typeof v === 'string' && v.trim().length);

    starters.push({
      id: starterId,
      pts: Number(ap.toFixed(2)),
      name: starterName,
      slot,
      team: teamCode ? String(teamCode).toUpperCase() : null,
      position: positionCode ? String(positionCode).toUpperCase() : null
    });
  }
  const teamName =
    [
      j?.team?.name,
      j?.team?.teamName,
      j?.teamName,
      j?.team_name,
      j?.team?.nickname,
      j?.fantasyTeam?.teamName
    ].find(v => typeof v === 'string' && v.trim().length) || null;

  return {
    points: Number(total.toFixed(2)),
    starters,
    teamName
  };
}

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

function parseWeekParam(value){
  if (value == null) return null;
  if (Array.isArray(value)) {
    const arr = value.map(Number).filter(n => Number.isFinite(n) && n > 0);
    return arr.length ? Array.from(new Set(arr)) : null;
  }
  const str = String(value).trim();
  if (!str) return null;
  const out = new Set();
  for (const token of str.split(/[,\s]+/)) {
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end   = Number(range[2]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const lo = Math.min(start, end);
        const hi = Math.max(start, end);
        for (let i = lo; i <= hi; i++) out.add(i);
      }
      continue;
    }
    const n = Number(token);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out.size ? Array.from(out) : null;
}
// GET /api/pools/teams?season=2025
router.get('/teams', async (req,res)=>{
  try{
    const { season } = req.query;
    if(!season) return res.status(400).json({error:'Season is required.'});
    const q = `
      SELECT DISTINCT
        season,
        league_id::text AS league_id,
        team_id::text   AS team_id,
        team_name,
        COALESCE(league_name,'') AS league_name,
        COALESCE(league_size,0)  AS league_size
      FROM ff_sport_ffl
      WHERE season=$1
      ORDER BY league_id, team_id`;
    const r = await pool.query(q, [season]);
    res.json({
      teams: r.rows.map(x=>({
        league_id: x.league_id,
        team_id:   x.team_id,
        team_name: x.team_name,
        league_name: x.league_name,
        league_size: Number(x.league_size ?? x.size) || 0,
        size: Number(x.size ?? x.league_size) || 0
      }))
    });
  }catch(e){ res.status(500).json({error:e.message}); }
});


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

    // First: whatever we have in DB (weekly or cache)
    const q = `
      WITH pairs AS (
        SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
      ),
      scor(scoring) AS (SELECT unnest($5::text[])),
      t_week AS (
        SELECT season, league_id::text AS league_id, team_id::text AS team_id,
               week, UPPER(scoring) AS scoring, points::numeric AS points, 1 AS pri
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND UPPER(scoring)=ANY($5)
      ),
      t_cache AS (
        SELECT c.season, (c.league_id)::text AS league_id, (c.team_id)::text AS team_id,
               c.week, UPPER(s.scoring) AS scoring,
               COALESCE(
                 CASE WHEN UPPER(s.scoring)='PPR'  AND (to_jsonb(c)->>'ppr_points')  ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'ppr_points')::numeric END,
                 CASE WHEN UPPER(s.scoring)='HALF' AND (to_jsonb(c)->>'half_points') ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'half_points')::numeric END,
                 CASE WHEN UPPER(s.scoring)='STD'  AND (to_jsonb(c)->>'std_points')  ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'std_points')::numeric END,
                 CASE WHEN (to_jsonb(c)->>'points') ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'points')::numeric END
               ) AS points, 2 AS pri
        FROM ff_team_points_cache c
        JOIN scor s ON TRUE
        WHERE c.season=$1 AND c.week = ANY($4)
      ),
      all_src AS (SELECT * FROM t_week UNION ALL SELECT * FROM t_cache),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY season, league_id, team_id, week, scoring ORDER BY pri) AS rn
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
    const baseRows = (await pool.query(q, [
      season,
      leagueIds.map(String),
      teamIds.map(String),
      weeks,
      scoring.map(s=>String(s).toUpperCase())
    ])).rows;

    const teamNameMap = new Map();
    const nameRows = await pool.query(
      `SELECT league_id::text AS league_id, team_id::text AS team_id, team_name
       FROM ff_sport_ffl
       WHERE season=$1`,
      [season]
    );
    for (const row of nameRows.rows) {
      if (row.team_name) teamNameMap.set(`${row.league_id}:${row.team_id}`, row.team_name);
    }
    for (const row of baseRows) {
      if (row.team_name) teamNameMap.set(`${row.league_id}:${row.team_id}`, row.team_name);
    }

    // Which (lid,tid,week,scoring) are missing team_points?
    const want = new Set();
    for (let i=0;i<leagueIds.length;i++){
      for (const wk of weeks){
        for (const sc of scoring){
          want.add(`${leagueIds[i]}:${teamIds[i]}:${wk}:${String(sc).toUpperCase()}`);
        }
      }
    }
    for (const r of baseRows){
      want.delete(`${r.league_id}:${r.team_id}:${r.week}:${r.scoring}`);
    }

    // Fill any missing from live ESPN roster as PPR (and clone for other scorings if you want)
    const extras = [];
    for (const key of want){
      const [lid, tid, wk, sc] = key.split(':');
      // one live fetch per (lid,tid,wk) — memoize by pair
      const memoKey = `${lid}:${tid}:${wk}`;
      if (!extras.some(e=>`${e.league_id}:${e.team_id}:${e.week}`===memoKey)) {
        try{
          const espn = await deriveFromEspnRoster({ season, week:+wk, leagueId:lid, teamId:tid });
          if (espn?.points != null) {
            const lookupKey = `${String(lid)}:${String(tid)}`;
            const derivedName = typeof espn.teamName === 'string' && espn.teamName.trim().length
              ? espn.teamName.trim()
              : teamNameMap.get(lookupKey) || null;
            if (derivedName) teamNameMap.set(lookupKey, derivedName);
            // default to PPR (works for our challenge settler which ignores scoring)
            extras.push({
              season, league_id: String(lid), team_id: String(tid),
              team_name: derivedName, week:+wk, scoring: 'PPR',
              team_points: Number(espn.points), pool_points: null,
              starters: espn.starters && espn.starters.length ? espn.starters : null
            });
          }
        }catch(e){ /* ignore individual fetch errors */ }
      }
    }

    res.json({ rows: [...baseRows, ...extras].sort((a,b)=>a.week-b.week || a.league_id.localeCompare(b.league_id) || a.team_id.localeCompare(b.team_id) || a.scoring.localeCompare(b.scoring)) });
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

    const weeklyLidType = await getType('ff_team_weekly_points','league_id');
    const weeklyTidType = await getType('ff_team_weekly_points','team_id');
    const weeklyLidCast = ['bigint','integer','numeric','smallint','decimal'].includes(weeklyLidType) ? `::${weeklyLidType}` : '::text';
    const weeklyTidCast = ['bigint','integer','numeric','smallint','decimal'].includes(weeklyTidType) ? `::${weeklyTidType}` : '::text';

    const teamNameMap = new Map();
    const teamRows = await client.query(
      `SELECT league_id::text AS league_id, team_id::text AS team_id, team_name
       FROM ff_sport_ffl
       WHERE season=$1`,
      [season]
    );
    for (const row of teamRows.rows) {
      if (row.team_name) teamNameMap.set(`${row.league_id}:${row.team_id}`, row.team_name);
    }

    await client.query('BEGIN');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_pools_key ON ff_pools(season, league_id, team_id, week, scoring);`);

    // 1) Upsert what we have in DB (weekly + cache) into ff_pools (same query as preview but insert)
    const q1 = `
      WITH pairs AS (
        SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
      ),
      scor(scoring) AS (SELECT unnest($5::text[])),
      t_week AS (
        SELECT season, league_id::text AS league_id, team_id::text AS team_id,
               week, UPPER(scoring) AS scoring, points::numeric AS points, 1 AS pri
        FROM ff_team_weekly_points
        WHERE season=$1 AND week = ANY($4) AND UPPER(scoring)=ANY($5)
      ),
      t_cache AS (
        SELECT c.season, (c.league_id)::text AS league_id, (c.team_id)::text AS team_id,
               c.week, UPPER(s.scoring) AS scoring,
               COALESCE(
                 CASE WHEN UPPER(s.scoring)='PPR'  THEN ff_safe_to_numeric(to_jsonb(c)->>'ppr_points') END,
                 CASE WHEN UPPER(s.scoring)='HALF' THEN ff_safe_to_numeric(to_jsonb(c)->>'half_points') END,
                 CASE WHEN UPPER(s.scoring)='STD'  THEN ff_safe_to_numeric(to_jsonb(c)->>'std_points') END,
                 ff_safe_to_numeric(to_jsonb(c)->>'points')
               )::numeric AS points, 2 AS pri
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
    await client.query(q1, [
      season,
      leagueIds.map(String),
      teamIds.map(String),
      weeks,
      scoring.map(s=>String(s).toUpperCase())
    ]);

    // 2) For any pairs still missing in ff_team_weekly_points, fetch ESPN and upsert PPR there + ff_pools
    const missing = await client.query(
      `WITH pairs AS (
         SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
       ),
       need AS (
         SELECT p.league_id, p.team_id, w AS week
         FROM pairs p CROSS JOIN unnest($4::int[]) AS w
         EXCEPT
         SELECT league_id::text, team_id::text, week FROM ff_team_weekly_points WHERE season=$1
       )
       SELECT * FROM need`,
      [season, leagueIds.map(String), teamIds.map(String), weeks]
    );

    const skipped = [];
    for (const row of missing.rows) {
      let espn = null;
      try {
        espn = await deriveFromEspnRoster({ season, week: row.week, leagueId: row.league_id, teamId: row.team_id });
      } catch (err) {
        console.warn('ff:pools:update deriveFromEspnRoster failed', {
          season,
          league_id: row.league_id,
          team_id: row.team_id,
          week: row.week,
          error: err?.message || err
        });
        skipped.push({
          league_id: String(row.league_id),
          team_id: String(row.team_id),
          week: row.week,
          error: err?.message || 'deriveFromEspnRoster failed'
        });
        continue;
      }
      if (!espn || espn.points == null) {
        skipped.push({
          league_id: String(row.league_id),
          team_id: String(row.team_id),
          week: row.week,
          error: 'No points returned from deriveFromEspnRoster'
        });
        continue;
      }

      const key = `${String(row.league_id)}:${String(row.team_id)}`;
      const derivedName = typeof espn.teamName === 'string' && espn.teamName.trim().length
        ? espn.teamName.trim()
        : teamNameMap.get(key) || null;
      if (derivedName) teamNameMap.set(key, derivedName);
      const startersPayload = espn.starters && espn.starters.length ? JSON.stringify(espn.starters) : null;
      const pointsValue = Number(espn.points);

      // Upsert weekly as PPR (settler doesn't care about scoring)
      await client.query(
        `INSERT INTO ff_team_weekly_points (season, week, league_id, team_id, scoring, points, team_name, starters, created_at, updated_at)
         VALUES ($1,$2,($3||'')${weeklyLidCast},($4||'')${weeklyTidCast},'PPR',$5,$6,$7,now(),now())
         ON CONFLICT (season, week, league_id, team_id, scoring)
         DO UPDATE SET points=EXCLUDED.points,
                       team_name=COALESCE(EXCLUDED.team_name, ff_team_weekly_points.team_name),
                       starters=COALESCE(EXCLUDED.starters, ff_team_weekly_points.starters),
                       updated_at=now()`,
        [season, row.week, String(row.league_id), String(row.team_id), pointsValue, derivedName, startersPayload]
      );

      // And mirror into ff_pools
      await client.query(
        `INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
         VALUES ($1, ($2||'')${lidCast}, ($3||'')${tidCast}, $4, 'PPR', $5, now(), now())
         ON CONFLICT (season, league_id, team_id, week, scoring)
         DO UPDATE SET "${pointsCol}"=EXCLUDED."${pointsCol}", updated_at=now()`,
        [season, String(row.league_id), String(row.team_id), row.week, pointsValue]
      );
    }

    await client.query('COMMIT');
    res.json({ ok:true, upserted: true, skipped });
  }catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({ok:false, error:e.message, stack:e.stack});
  } finally { client.release(); }
});


module.exports = router;








