// routes/fp_ingest.js
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();
router.use(express.json({ limit: '12mb' }));

// Use global fetch if present (Node 18+); otherwise lazy-load node-fetch
const _fetch = async (...args) =>
  (typeof fetch !== 'undefined'
    ? fetch(...args)
    : (await import('node-fetch')).default(...args));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ----------------------------- DDL (tables) ----------------------------- */
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
  fp_id     int PRIMARY KEY,
  player_id int,
  espn_id   int,
  notes     text
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

/* --------------------------- small helpers ------------------------------ */
const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const ALL_SCORINGS = ['STD', 'HALF', 'PPR'];

/* --------------------- Name/Team/Pos normalization ---------------------- */
// Canonical first, then variants/synonyms.
const NAME_SYNONYM_LIST = [
  ['patrick mahomes ii', 'patrick mahomes'],
  ['james cook iii', 'james cook'],
  ['kenneth walker', 'kenneth walker iii'],
  ['brian robinson', 'brian robinson jr'],
  ['marvin harrison', 'marvin harrison jr'],

  ['deebo samuel', 'deebo samuel sr', 'deebo samuel sr.'],

  ["d'andre swift", 'dandre swift'],
  ['juju smith-schuster', 'juju smith schuster'],
  ["ja'marr chase", 'jamarr chase'],
  ['marquise brown', 'hollywood brown'],

  // common dot/space issues
  ['dj moore', 'd.j. moore', 'd j moore'],
  ['dk metcalf', 'd.k. metcalf', 'd k metcalf'],
  ['aj brown', 'a.j. brown', 'a j brown'],
  ['tj hockenson', 't.j. hockenson', 't j hockenson'],
  ["de'von achane", 'devon achane'],
];

const _variantToCanonical = (() => {
  const m = new Map();
  for (const arr of NAME_SYNONYM_LIST) {
    const canonical = normName(arr[0]);
    for (const v of arr) m.set(normName(v), canonical);
  }
  return m;
})();

function normName(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/&/g, ' and ')
    .replace(/[.'"]/g, '') // remove periods & apostrophes/quotes
    .replace(/-/g, ' ')
    .replace(/\b(sr|jr|ii|iii|iv|v)\b/g, '') // drop suffixes for matching
    .replace(/\s+/g, ' ')
    .trim();
}
function canonName(s = '') {
  const k = normName(s);
  return _variantToCanonical.get(k) || k;
}

const TEAM_ALIAS = {
  WSH: 'WAS', WAS: 'WAS',
  JAX: 'JAC', JAC: 'JAC',
  LA: 'LAR',  LAR: 'LAR', LAC: 'LAC',
  NO: 'NO',   NOR: 'NO',
  GB: 'GB',   GNB: 'GB',
  KC: 'KC',   KAN: 'KC',
  TB: 'TB',   TAM: 'TB',
};
function normTeam(abbr) {
  const u = String(abbr || '').toUpperCase().trim();
  return TEAM_ALIAS[u] || u;
}
function normPos(p) {
  return String(p || '').toUpperCase().trim();
}

/* ----------------------------- Diagnostics ------------------------------ */
router.get('/api/fp/diagnose', async (_req, res) => {
  try {
    const out = {};
    out.tables = await q(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
        ('ff_fp_points_week','ff_team_weekly_points','ff_team_points_cache','ff_espn_roster_week','ff_fp_player_map')
      ORDER BY table_name`);
    out.fp_points_sample = await q(`SELECT * FROM ff_fp_points_week ORDER BY season DESC, week DESC LIMIT 3`);
    out.roster_sample = await q(`SELECT * FROM ff_espn_roster_week ORDER BY season DESC, week DESC LIMIT 3`).catch(() => []);
    res.json({ ok: true, diagnose: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ----------------------------- Ensure DDL ------------------------------- */
router.post('/api/fp/ensure-ddl', async (_req, res) => {
  try {
    await pool.query(DDL);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* --------------------------- Ingest (staging) --------------------------- */
router.post('/api/fp/ingest-batch', async (req, res) => {
  const { season, batches } = req.body || {};
  if (!season || !Array.isArray(batches)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  const client = await pool.connect();
  try {
    await client.query(DDL);
    await client.query('BEGIN');

    // Flatten all players across batches into typed arrays
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
          Number(p.points) || 0,
        ]);
      }
    }

    const CHUNK = 2000;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const cols = ['season', 'week', 'scoring', 'fp_id', 'name', 'position', 'team_abbr', 'points'];
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
      await client.query(sql, arrays);
    }

    await client.query('COMMIT');
    res.json({ ok: true, season, batches: batches.length, upserted_rows: records.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ingest-batch error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    client.release();
  }
});
// ---- helpers (put near the top with the other utils) --------------------
function pickStr(...vals) {
  for (const v of vals) {
    if (v === 0) continue;
    const s = (v ?? '').toString().trim();
    if (s) return s;
  }
  return '';
}

function rosterFields(p) {
  // name
  const name = pickStr(
    p.name, p.fullName, p.displayName,
    p.player?.fullName, p.player?.name,
    (p.player?.firstName && p.player?.lastName) ? `${p.player.firstName} ${p.player.lastName}` : ''
  );

  // team abbr (many shapes)
  const team = pickStr(
    p.team, p.teamAbbr, p.teamAbbrev, p.team_abbr,
    p.proTeamAbbr, p.proTeam, p.nflTeam,
    p.player?.proTeamAbbr, p.player?.proTeamAbbrev, p.player?.proTeamAbbreviation
  );

  // position
  const pos = pickStr(
    p.position, p.pos, p.slot, p.slotAbbr,
    p.player?.position, p.player?.defaultPositionAbbrev
  );

  // fantasypros id if present anywhere
  const fpId = Number(
    p.fpId ??
    p.fantasyProsId ??
    p.externalIds?.fantasyProsId ??
    p.player?.fantasyProsId ??
    NaN
  );

  return {
    name, team: normTeam(team), pos: normPos(pos),
    fpId: Number.isFinite(fpId) ? fpId : null
  };
}

/* ------------------------ Apply to League (build) ----------------------- */
// ------------------------ Apply to League (replace) ----------------------
router.post('/api/fp/apply-to-league', async (req, res) => {
  const { season, league_id, cutoffWeek = null } = req.body || {};
  const scorings = ['STD', 'HALF', 'PPR'];
  if (!season || !league_id) {
    return res.status(400).json({ ok:false, error:'missing season/league_id' });
  }

  const baseURL = process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const client = await pool.connect();

  try {
    await client.query(DDL);

    // Weeks we have FP points for
    const wkSQL = `
      SELECT DISTINCT week
      FROM ff_fp_points_week
      WHERE season=$1 AND scoring = ANY($2) ${cutoffWeek ? 'AND week <= $3' : ''}
      ORDER BY week`;
    const wkParams = cutoffWeek
      ? [Number(season), scorings, Number(cutoffWeek)]
      : [Number(season), scorings];
    const { rows: wkRows } = await client.query(wkSQL, wkParams);
    if (!wkRows.length) {
      return res.status(400).json({ ok:false, error:'no_fp_points_for_season_or_scoring' });
    }

    // Build roster indexes per week
    const rostersByWeek = new Map(); // week -> { byFpId, byNTP, byNT, byN }
    const warnings = [];

    for (const { week } of wkRows) {
      const url = `${baseURL}/api/platforms/espn/roster?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(league_id)}&week=${encodeURIComponent(week)}`;
      try {
        const r = await (typeof fetch !== 'undefined' ? fetch(url) : (await import('node-fetch')).default(url));
        const j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || `roster_fetch_${r.status}`);

        const byFpId = new Map();
        const byNTP  = new Map(); // name|team|pos
        const byNT   = new Map(); // name|team
        const byN    = new Map(); // name

        for (const team of (j.teams || [])) {
          const tid = Number(team.teamId);
          for (const p of (team.players || [])) {
            const f = rosterFields(p);

            const n  = canonName(f.name);
            const ta = normTeam(f.team);
            const po = normPos(f.pos);

            if (f.fpId) byFpId.set(f.fpId, tid);

            const k1 = `${n}|${ta}|${po}`;
            const k2 = `${n}|${ta}`;
            const k3 = `${n}`;

            if (n) {
              if (!byNTP.has(k1)) byNTP.set(k1, tid);
              if (!byNT.has(k2))  byNT.set(k2, tid);
              if (!byN.has(k3))   byN.set(k3, tid);
            }
          }
        }

        // small debug snapshot to help when matched==0
        const sample = 3;
        const peek = {
          fpId: Array.from(byFpId.keys()).slice(0, sample),
          nTp:  Array.from(byNTP.keys()).slice(0, sample),
          nT:   Array.from(byNT.keys()).slice(0, sample),
          n:    Array.from(byN.keys()).slice(0, sample),
        };

        rostersByWeek.set(Number(week), { byFpId, byNTP, byNT, byN, peek });
      } catch (e) {
        warnings.push(`week ${week}: ${e.message}`);
        rostersByWeek.set(Number(week), { byFpId:new Map(), byNTP:new Map(), byNT:new Map(), byN:new Map(), peek:{} });
      }
    }

    // Pull staged FP rows
    const weeksArr = wkRows.map(w => Number(w.week));
    const { rows: fpRows } = await client.query(
      `SELECT week, scoring, fp_id, name, position, team_abbr, points
       FROM ff_fp_points_week
       WHERE season=$1 AND scoring = ANY($2) AND week = ANY($3::int[])`,
      [Number(season), scorings, weeksArr]
    );

    // Aggregate
    const agg = new Map(); // season|league|team|week|scoring -> points
    const akey = (tid, w, sc) => `${season}|${league_id}|${tid}|${w}|${sc}`;

    let matched = 0, unmatched = 0;

    for (const row of fpRows) {
      const week    = Number(row.week);
      const scoring = String(row.scoring).toUpperCase();
      const maps    = rostersByWeek.get(week);
      if (!maps) { unmatched++; continue; }

      const n  = canonName(row.name);
      const ta = normTeam(row.team_abbr);
      const po = normPos(row.position);
      const k1 = `${n}|${ta}|${po}`;
      const k2 = `${n}|${ta}`;
      const k3 = `${n}`;

      let tid = null;

      // priority: fpId -> name+team+pos -> name+team -> name
      if (Number.isFinite(row.fp_id) && maps.byFpId.has(row.fp_id)) {
        tid = maps.byFpId.get(row.fp_id);
      } else {
        tid = maps.byNTP.get(k1) ?? maps.byNT.get(k2) ?? maps.byN.get(k3) ?? null;
      }

      if (!tid) { unmatched++; continue; }

      matched++;
      const k = akey(tid, week, scoring);
      agg.set(k, (agg.get(k) || 0) + Number(row.points || 0));
    }

    if (matched === 0) {
      // include a tiny peek at week 1 index keys to debug quickly in UI
      const wk1 = rostersByWeek.get(weeksArr[0]);
      return res.status(400).json({
        ok:false,
        error:'no_roster_matches',
        details:{ warnings, unmatched, sampleIndex: wk1?.peek || {} }
      });
    }

    // === upsert weekly + week1 totals + cache (unchanged from your version) ===
    await client.query('BEGIN');

    const rows = Array.from(agg.entries()).map(([k, pts]) => {
      const [s, l, t, w, sc] = k.split('|');
      return [Number(s), String(l), Number(t), Number(w), String(sc), Number(pts)];
    });

    const nameSQL = `SELECT team_id, team_name FROM ff_sport_ffl WHERE season=$1 AND league_id=$2`;
    const names   = await q(nameSQL, [Number(season), String(league_id)]);
    const nameMap = new Map(names.map(r => [Number(r.team_id), r.team_name || `Team ${r.team_id}`]));

    const S=[],L=[],T=[],W=[],SC=[],PTS=[],TN=[];
    for (const [s,l,t,w,sc,pts] of rows) {
      S.push(s); L.push(l); T.push(t); W.push(w); SC.push(sc); PTS.push(pts);
      TN.push(nameMap.get(t) || `Team ${t}`);
    }

    if (rows.length) {
      await client.query(
        `INSERT INTO ff_team_weekly_points
           (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
         SELECT * FROM unnest(
           $1::int[], $2::text[], $3::int[], $4::int[], $5::text[], $6::numeric[], $7::jsonb[], $8::text[], $9::timestamptz[], $10::timestamptz[]
         )
         ON CONFLICT (season, league_id, team_id, week, scoring)
         DO UPDATE SET team_name=EXCLUDED.team_name, points=EXCLUDED.points, updated_at=now()`,
        [S,L,T,W,TN,PTS,Array(S.length).fill('[]'),SC,Array(S.length).fill(new Date().toISOString()),Array(S.length).fill(new Date().toISOString())]
      );
    }

    await client.query(
      `WITH totals AS (
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
       DO UPDATE SET team_name=EXCLUDED.team_name, points=EXCLUDED.points, updated_at=now()`,
      [Number(season), String(league_id), scorings, cutoffWeek ? Number(cutoffWeek) : null]
    );

    await client.query(
      `WITH latest AS (
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
         week_pts=EXCLUDED.week_pts, season_pts=EXCLUDED.season_pts, updated_at=now()`,
      [Number(season), String(league_id), scorings]
    );

    await client.query('COMMIT');
    res.json({ ok:true, matched, unmatched, weeks: weeksArr, warnings });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('apply-to-league matcher error:', e);
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    client.release();
  }
});


module.exports = router;
