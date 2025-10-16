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

// Always process these three
const ALL_SCORINGS = ['STD','HALF','PPR'];

// normalize helpers
function normName(s) {
  if (!s) return '';
  return s.normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')          // strip diacritics
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/gi,'') // drop suffixes
    .replace(/[^a-z0-9]+/gi,'')              // remove non-alnum
    .toLowerCase();
}
const TEAM_ALIAS = {
  WSH:'WAS', WAS:'WAS',
  JAX:'JAC', JAC:'JAC',
  LA:'LAR',  LAR:'LAR', LAC:'LAC',
  NO:'NO',   NOR:'NO',
  GB:'GB',   GNB:'GB',
  KC:'KC',   KAN:'KC',
  TB:'TB',   TAM:'TB',
};
function normTeam(abbr) {
  const u = String(abbr||'').toUpperCase();
  return TEAM_ALIAS[u] || u;
}
function normPos(p){ return String(p||'').toUpperCase(); }

router.post('/api/fp/apply-to-league', async (req, res) => {
  const { season, league_id, cutoffWeek = null } = req.body || {};
  const scorings = ALL_SCORINGS;
  if (!season || !league_id) return res.status(400).json({ ok:false, error:'missing season/league_id' });

  const baseURL = process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const client = await pool.connect();

  try {
    await client.query(DDL);

    // weeks we have FP points for
    const wkSQL = `
      SELECT DISTINCT week
      FROM ff_fp_points_week
      WHERE season=$1 AND scoring = ANY($2) ${cutoffWeek ? 'AND week <= $3' : ''}
      ORDER BY week`;
    const wkParams = cutoffWeek
      ? [Number(season), scorings, Number(cutoffWeek)]
      : [Number(season), scorings];
    const { rows: wkRows } = await client.query(wkSQL, wkParams);
    if (!wkRows.length) return res.status(400).json({ ok:false, error:'no_fp_points_for_season_or_scoring' });

    // 1) Build roster index for each week: prefer fpId; else name+team+pos
    const rostersByWeek = new Map();  // week -> { byFpId: Map<fpId, teamId>, byKey: Map<key, teamId> }
    const warnings = [];

    for (const { week } of wkRows) {
      const url = `${baseURL}/api/platforms/espn/roster?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(league_id)}&week=${encodeURIComponent(week)}`;
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || `roster_fetch_${r.status}`);

        const byFpId = new Map();
        const byKey  = new Map();

        for (const team of (j.teams || [])) {
          const tid = Number(team.teamId);
          for (const p of (team.players || [])) {
            const fp = Number(p.fpId ?? p?.externalIds?.fantasyProsId ?? NaN);
            const pos = normPos(p.position);
            const teamAbbr = normTeam(p.team);
            const key = `${normName(p.name)}|${teamAbbr}|${pos}`;
            if (Number.isFinite(fp)) byFpId.set(fp, tid);
            if (!byKey.has(key)) byKey.set(key, tid); // first claim wins
          }
        }

        rostersByWeek.set(Number(week), { byFpId, byKey });
      } catch (e) {
        warnings.push(`week ${week}: ${e.message}`);
        // still create empty maps so apply continues for other weeks
        rostersByWeek.set(Number(week), { byFpId: new Map(), byKey: new Map() });
      }
    }

    // 2) Pull FP points we’ve staged for those weeks+scorings
    const weeksArr = wkRows.map(w => Number(w.week));
    const { rows: fpRows } = await client.query(
      `
      SELECT week, scoring, fp_id, name, position, team_abbr, points
      FROM ff_fp_points_week
      WHERE season=$1 AND scoring = ANY($2) AND week = ANY($3::int[])
      `,
      [Number(season), scorings, weeksArr]
    );

    // 3) Aggregate to team totals using roster mapping
    //    Priority: fpId → team; fallback: name+team+pos → team
    const agg = new Map(); // key: season|league|team_id|week|scoring → points
    function akey(tid, week, scoring){ return `${season}|${league_id}|${tid}|${week}|${scoring}`; }

    let matched = 0, unmatched = 0;
    for (const row of fpRows) {
      const week = Number(row.week);
      const scoring = String(row.scoring).toUpperCase();
      const maps = rostersByWeek.get(week);
      if (!maps) { unmatched++; continue; }

      let tid = null;
      if (Number.isFinite(row.fp_id) && maps.byFpId.has(row.fp_id)) {
        tid = maps.byFpId.get(row.fp_id);
      } else {
        const key = `${normName(row.name)}|${normTeam(row.team_abbr)}|${normPos(row.position)}`;
        tid = maps.byKey.get(key) ?? null;
      }

      if (!tid) { unmatched++; continue; }

      matched++;
      const k = akey(tid, week, scoring);
      agg.set(k, (agg.get(k) || 0) + Number(row.points || 0));
    }

    // If literally nothing matched, bail with a helpful error
    if (matched === 0) {
      return res.status(400).json({ ok:false, error:'no_roster_matches', details:{ warnings, unmatched } });
    }

    // 4) Upsert weekly rows and refresh totals/cache
    await client.query('BEGIN');

    // Upsert weekly in chunks
    const rows = Array.from(agg.entries()).map(([k, pts]) => {
      const [s, l, t, w, sc] = k.split('|');
      return [Number(s), String(l), Number(t), Number(w), String(sc), Number(pts)];
    });

    // materialize team names
    const nameSQL = `
      SELECT team_id, team_name
      FROM ff_sport_ffl
      WHERE season=$1 AND league_id=$2`;
    const { rows: names } = await client.query(nameSQL, [Number(season), String(league_id)]);
    const nameMap = new Map(names.map(r => [Number(r.team_id), r.team_name || `Team ${r.team_id}`]));

    const S=[],L=[],T=[],W=[],SC=[],PTS=[],TN=[];
    for (const [s,l,t,w,sc,pts] of rows) {
      S.push(s); L.push(l); T.push(t); W.push(w); SC.push(sc); PTS.push(pts); TN.push(nameMap.get(t) || `Team ${t}`);
    }

    if (rows.length) {
      await client.query(
        `
        INSERT INTO ff_team_weekly_points
          (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
        SELECT * FROM unnest(
          $1::int[], $2::text[], $3::int[], $4::int[], $5::text[], $6::numeric[], $7::jsonb[], $8::text[], $9::timestamptz[], $10::timestamptz[]
        )
        ON CONFLICT (season, league_id, team_id, week, scoring)
        DO UPDATE SET team_name=EXCLUDED.team_name, points=EXCLUDED.points, updated_at=now()
        `,
        [ S, L, T, W, TN, PTS,
          Array(S.length).fill('[]'),               // starters placeholder
          SC,
          Array(S.length).fill(new Date().toISOString()),
          Array(S.length).fill(new Date().toISOString())
        ]
      );
    }

    // week=1 season totals up to cutoff/max
    await client.query(
      `
      WITH totals AS (
        SELECT season, league_id, team_id, scoring, SUM(points)::numeric AS sum_pts
        FROM ff_team_weekly_points
        WHERE season=$1 AND league_id=$2 AND scoring = ANY($3)
          AND week BETWEEN 2 AND COALESCE($4::int, 99)
        GROUP BY 1,2,3,4
      )
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
      `,
      [Number(season), String(league_id), scorings, cutoffWeek ? Number(cutoffWeek) : null]
    );

    // refresh cache
    await client.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (season, league_id, team_id, scoring)
               season, league_id, team_id, scoring, week, points, 
               COALESCE(s.team_name, 'Team '||w.team_id) AS team_name
        FROM ff_team_weekly_points w
        LEFT JOIN ff_sport_ffl s
          ON s.season=w.season AND s.league_id=w.league_id AND s.team_id=w.team_id
        WHERE season=$1 AND league_id=$2 AND scoring = ANY($3)
        ORDER BY season, league_id, team_id, scoring, week DESC, updated_at DESC
      ),
      season_tot AS (
        SELECT season, league_id, team_id, scoring, SUM(points)::numeric AS season_pts
        FROM ff_team_weekly_points
        WHERE season=$1 AND league_id=$2 AND scoring = ANY($3)
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
      `,
      [Number(season), String(league_id), scorings]
    );

    await client.query('COMMIT');

    res.json({
      ok:true,
      matched,
      unmatched,
      weeks: weeksArr,
      warnings
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('apply-to-league(name-match) error:', e);
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});



module.exports = router;
