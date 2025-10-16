// routes/fp_ingest.js
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();
router.use(express.json({ limit: '12mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DDL = `
CREATE TABLE IF NOT EXISTS ff_fp_points_week (
  season     int    NOT NULL,
  week       int    NOT NULL,
  scoring    text   NOT NULL CHECK (scoring IN ('STD','HALF','PPR')),
  fp_id      int    NOT NULL,
  name       text   NOT NULL,
  position   text   NOT NULL,
  team_abbr  text   NOT NULL,
  points     numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, week, scoring, fp_id)
);

CREATE TABLE IF NOT EXISTS ff_fp_player_map (
  fp_id   int PRIMARY KEY,
  player_id int,
  espn_id  int,
  notes   text
);

CREATE TABLE IF NOT EXISTS ff_team_weekly_points (
  season      int      NOT NULL,
  league_id   text     NOT NULL,
  team_id     int      NOT NULL,
  week        int      NOT NULL,
  team_name   text     NOT NULL,
  points      numeric  NOT NULL DEFAULT 0,
  starters    jsonb    NOT NULL DEFAULT '[]'::jsonb,
  scoring     text     NOT NULL CHECK (scoring IN ('STD','HALF','PPR')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, league_id, team_id, week, scoring)
);

CREATE TABLE IF NOT EXISTS ff_team_points_cache (
  season      int      NOT NULL,
  league_id   text     NOT NULL,
  team_id     int      NOT NULL,
  team_name   text     NOT NULL,
  scoring     text     NOT NULL CHECK (scoring IN ('STD','HALF','PPR')),
  week        int      NOT NULL,
  week_pts    numeric  NOT NULL DEFAULT 0,
  season_pts  numeric  NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, league_id, team_id, scoring, week)
);
CREATE UNIQUE INDEX IF NOT EXISTS ff_team_points_cache_uniq4
  ON ff_team_points_cache (season, league_id, team_id, scoring);
`;
// routes/fp_ingest.js (CommonJS) — add near the top
router.get('/api/fp/diagnose', async (_req, res) => {
  try {
    const out = {};
    const q = (sql, params=[]) => pool.query(sql, params).then(r=>r.rows);
    out.tables = await q(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
        ('ff_fp_points_week','ff_team_weekly_points','ff_team_points_cache','ff_espn_roster_week','ff_fp_player_map')
      ORDER BY table_name`);
    out.fp_points_sample = await q(`SELECT * FROM ff_fp_points_week ORDER BY season DESC, week DESC LIMIT 3`);
    out.roster_sample   = await q(`SELECT * FROM ff_espn_roster_week ORDER BY season DESC, week DESC LIMIT 3`).catch(()=>[]);
    res.json({ ok:true, diagnose: out });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/** Ensure tables exist */
router.post('/api/fp/ensure-ddl', async (_req, res) => {
  try {
    await pool.query(DDL);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/** Stage batches from GUI */
router.post('/api/fp/ingest-batch', async (req, res) => {
  const { season, batches } = req.body || {};
  if (!season || !Array.isArray(batches)) return res.status(400).json({ ok:false, error:'bad_request' });

  const client = await pool.connect();
  try {
    await client.query(DDL);
    await client.query('BEGIN');
    let rows = 0;

    // flatten records
    const records = [];
    for (const b of batches) {
      const scoring = String(b.scoring || '').toUpperCase();
      for (const p of (b.players || [])) {
        records.push([
          Number(b.season || season),
          Number(b.week),
          scoring,
          Number(p.fpId ?? p.fp_id),
          String(p.name || ''),
          String(p.position || ''),
          String(p.team || p.team_abbr || ''),
          Number(p.points) || 0
        ]);
      }
    }

    // chunk into 2k rows per insert
    const CHUNK = 2000;
    for (let i=0; i<records.length; i+=CHUNK) {
      const chunk = records.slice(i, i+CHUNK);
      const cols = ['season','week','scoring','fp_id','name','position','team_abbr','points'];
      const params = { };
      const arrays = cols.map((_c, idx) => chunk.map(r => r[idx]));

      const sql = `
        INSERT INTO ff_fp_points_week (season, week, scoring, fp_id, name, position, team_abbr, points)
        SELECT * FROM unnest(
          $1::int[], $2::int[], $3::text[], $4::int[],
          $5::text[], $6::text[], $7::text[], $8::numeric[]
        )
        ON CONFLICT (season, week, scoring, fp_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          position = EXCLUDED.position,
          team_abbr = EXCLUDED.team_abbr,
          points = EXCLUDED.points,
          updated_at = now();`;
      const r = await client.query(sql, arrays);

      rows += r.rowCount || 0;
    }

    await client.query('COMMIT');
    res.json({ ok:true, season, batches:batches.length, upserted_rows: rows });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ingest-batch error:', e);
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});

// routes/fp_ingest.js  — replace the whole /apply-to-league handler with this:
router.post('/api/fp/apply-to-league', async (req, res) => {
  const { season, league_id, scorings = ['STD','HALF','PPR'], cutoffWeek = null } = req.body || {};
  if (!season || !league_id) return res.status(400).json({ ok:false, error:'missing season/league_id' });

  // Where to call our own roster route from (same service). Node 18+ has global fetch.
  const baseURL =
    process.env.INTERNAL_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;

  const client = await pool.connect();
  try {
    await client.query(DDL);

    // 1) figure out which weeks we need (from staged FP points)
    const wkSQL = `
      SELECT DISTINCT week
      FROM ff_fp_points_week
      WHERE season=$1 AND scoring = ANY($2)
        ${cutoffWeek ? 'AND week <= $3' : ''}
      ORDER BY week`;
    const wkParams = cutoffWeek ? [Number(season), scorings.map(String), Number(cutoffWeek)] : [Number(season), scorings.map(String)];
    const { rows: wkRows } = await client.query(wkSQL, wkParams);
    if (wkRows.length === 0) {
      return res.status(400).json({ ok:false, error:'no_fp_points_for_season_or_scoring' });
    }

    // 2) pull rosters from your ESPN route for each week
    const rosterRows = []; // [season, week, league_id, team_id, fp_id]
    const warnings = [];
    for (const { week } of wkRows) {
      const url = `${baseURL}/api/platforms/espn/roster?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(league_id)}&week=${encodeURIComponent(week)}`;
      let j;
      try {
        const r = await fetch(url);
        j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || `roster_fetch_failed_${r.status}`);
      } catch (e) {
        warnings.push(`week ${week}: ${e.message}`);
        continue;
      }
      const teams = Array.isArray(j.teams) ? j.teams : [];
      for (const t of teams) {
        const teamId = Number(t.teamId);
        if (!Number.isFinite(teamId)) continue;
        const players = Array.isArray(t.players) ? t.players : [];
        for (const p of players) {
          const fpId = Number(p.fpId ?? p.fpid ?? p?.externalIds?.fantasyProsId);
          if (Number.isFinite(fpId)) {
            rosterRows.push([Number(season), Number(week), String(league_id), teamId, fpId]);
          }
        }
      }
    }

    if (rosterRows.length === 0) {
      return res.status(400).json({ ok:false, error:'no_roster_fpids_found', warnings });
    }

    // de-dup (player might appear twice via multiple views)
    const seen = new Set();
    const uniq = [];
    for (const r of rosterRows) {
      const k = `${r[1]}|${r[3]}|${r[4]}`; // week|team_id|fp_id
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(r);
    }

    await client.query('BEGIN');

    // 3) temp roster map for SQL joins
    await client.query('CREATE TEMP TABLE tmp_roster_map (season int, week int, league_id text, team_id int, fp_id int) ON COMMIT DROP');
    const S = uniq.map(r => r[0]);
    const W = uniq.map(r => r[1]);
    const L = uniq.map(r => r[2]);
    const T = uniq.map(r => r[3]);
    const F = uniq.map(r => r[4]);
    await client.query(
      `INSERT INTO tmp_roster_map (season, week, league_id, team_id, fp_id)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::int[])`,
      [S, W, L, T, F]
    );

    // 4) one SQL pass: weekly → week=1 totals → cache
    const sql = `
      WITH filt AS (
        SELECT f.season, f.week, m.league_id, m.team_id, f.scoring, f.points
        FROM ff_fp_points_week f
        JOIN tmp_roster_map m
          ON m.season=f.season AND m.week=f.week AND m.fp_id=f.fp_id
        WHERE f.season=$1 AND m.league_id=$2 AND f.scoring = ANY($3)
          AND ($4::int IS NULL OR f.week <= $4::int)
          AND f.week BETWEEN 2 AND COALESCE($4::int, 99)
      ),
      agg AS (
        SELECT season, league_id, team_id, week, scoring, SUM(points)::numeric AS pts
        FROM filt GROUP BY 1,2,3,4,5
      ),
      named AS (
        SELECT a.*, COALESCE(s.team_name, 'Team '||a.team_id) AS team_name
        FROM agg a
        LEFT JOIN ff_sport_ffl s
          ON s.season=a.season AND s.league_id=a.league_id AND s.team_id=a.team_id
      ),
      up_weekly AS (
        INSERT INTO ff_team_weekly_points
          (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
        SELECT season, league_id, team_id, week, team_name, pts, '[]'::jsonb, scoring, now(), now()
        FROM named
        ON CONFLICT (season, league_id, team_id, week, scoring)
        DO UPDATE SET team_name=EXCLUDED.team_name, points=EXCLUDED.points, updated_at=now()
        RETURNING 1
      ),
      totals AS (
        SELECT season, league_id, team_id, scoring, SUM(points)::numeric AS sum_pts
        FROM ff_team_weekly_points
        WHERE season=$1 AND league_id::text=$2 AND scoring = ANY($3)
          AND week BETWEEN 2 AND COALESCE($4::int, 99)
        GROUP BY 1,2,3,4
      ),
      up_totals AS (
        INSERT INTO ff_team_weekly_points
          (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
        SELECT t.season, t.league_id, t.team_id, 1,
               COALESCE(s.team_name, 'Team '||t.team_id),
               t.sum_pts, '[]'::jsonb, t.scoring, now(), now()
        FROM totals t
        LEFT JOIN ff_sport_ffl s
          ON s.season=t.season AND s.league_id=t.league_id AND s.team_id=t.team_id
        ON CONFLICT (season, league_id, team_id, week, scoring)
        DO UPDATE SET team_name=EXCLUDED.team_name, points=EXCLUDED.points, updated_at=now()
        RETURNING 1
      ),
      latest AS (
        SELECT DISTINCT ON (season, league_id, team_id, scoring)
               season, league_id, team_id, scoring, week, points,
               COALESCE(s.team_name, 'Team '||w.team_id) AS team_name
        FROM ff_team_weekly_points w
        LEFT JOIN ff_sport_ffl s
          ON s.season=w.season AND s.league_id=w.league_id AND s.team_id=w.team_id
        WHERE season=$1 AND league_id::text=$2 AND scoring = ANY($3)
        ORDER BY season, league_id, team_id, scoring, week DESC, updated_at DESC
      ),
      season_tot AS (
        SELECT season, league_id, team_id, scoring, SUM(points)::numeric AS season_pts
        FROM ff_team_weekly_points
        WHERE season=$1 AND league_id::text=$2 AND scoring = ANY($3)
        GROUP BY 1,2,3,4
      )
      INSERT INTO ff_team_points_cache AS c
        (season, league_id, team_id, team_name, scoring, week, week_pts, season_pts, updated_at)
      SELECT l.season, l.league_id, l.team_id, l.team_name, l.scoring,
             l.week, l.points, s.season_pts, now()
      FROM latest l
      JOIN season_tot s USING (season, league_id, team_id, scoring)
      ON CONFLICT (season, league_id, team_id, scoring)
      DO UPDATE SET
        team_name=EXCLUDED.team_name, week=EXCLUDED.week,
        week_pts=EXCLUDED.week_pts, season_pts=EXCLUDED.season_pts, updated_at=now()
      RETURNING 1;
    `;

    const up = await client.query(sql, [
      Number(season),
      String(league_id),
      scorings.map(s => String(s).toUpperCase()),
      cutoffWeek ? Number(cutoffWeek) : null
    ]);

    await client.query('COMMIT');
    res.json({ ok:true, cache_rows: up.rowCount || 0, warnings });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('apply-to-league(live roster) error:', e);
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});


module.exports = router;
