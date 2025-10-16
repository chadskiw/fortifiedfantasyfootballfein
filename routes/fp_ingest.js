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

    for (const b of batches) {
      const vals = [];
      for (const p of (b.players || [])) {
        const name = String(p.name || '').replace(/'/g, "''");
        const pos  = String(p.position || '').replace(/'/g, "''");
        const team = String(p.team || p.team_abbr || '').replace(/'/g, "''");
        vals.push(`(${[
          b.season || season, b.week, `'${String(b.scoring).toUpperCase()}'`,
          Number(p.fpId ?? p.fp_id), `'${name}'`, `'${pos}'`, `'${team}'`, Number(p.points) || 0
        ].join(',')})`);
      }
      if (!vals.length) continue;

      const sql = `
        INSERT INTO ff_fp_points_week (season, week, scoring, fp_id, name, position, team_abbr, points, updated_at)
        VALUES ${vals.join(',')}
        ON CONFLICT (season, week, scoring, fp_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          position = EXCLUDED.position,
          team_abbr = EXCLUDED.team_abbr,
          points = EXCLUDED.points,
          updated_at = now();
      `;
      const r = await client.query(sql);
      rows += r.rowCount || 0;
    }

    await client.query('COMMIT');
    res.json({ ok:true, season, batches:batches.length, upserted_rows: rows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});

/** Apply staged FP rows to a league: build weekly totals + season totals + refresh cache */
router.post('/api/fp/apply-to-league', async (req, res) => {
  const { season, league_id, scorings = ['STD','HALF','PPR'], cutoffWeek = null } = req.body || {};
  if (!season || !league_id) return res.status(400).json({ ok:false, error:'missing season/league_id' });

  const client = await pool.connect();
  try {
    await client.query(DDL);
    await client.query('BEGIN');

    const weeklySQL = `
      WITH roster AS (
        SELECT season, week, league_id::text AS league_id, team_id,
               COALESCE(r.fp_id, m.fp_id) AS fp_id
        FROM ff_espn_roster_week r
        LEFT JOIN ff_fp_player_map m ON m.player_id = r.player_id
        WHERE season = $1 AND league_id::text = $2
      ),
      filt AS (
        SELECT f.season, f.week, f.scoring, r.league_id, r.team_id, f.points
        FROM ff_fp_points_week f
        JOIN roster r ON r.season=f.season AND r.week=f.week AND r.fp_id=f.fp_id
        WHERE f.scoring = ANY($3)
          AND ($4::int IS NULL OR f.week <= $4::int)
      ),
      agg AS (
        SELECT season, league_id, team_id, week, scoring, SUM(points)::numeric AS pts
        FROM filt
        GROUP BY 1,2,3,4,5
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
        WHERE season=$1 AND league_id::text=$2 AND scoring = ANY($3) AND week BETWEEN 2 AND COALESCE($4::int, 99)
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

    const upw = await client.query(weeklySQL, [
      Number(season), String(league_id), scorings.map(String), cutoffWeek ?? null
    ]);

    await client.query('COMMIT');
    res.json({ ok:true, weekly_rows: '✔', season_rows: '✔', cache_rows: upw.rowCount || 0 });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});

module.exports = router;
