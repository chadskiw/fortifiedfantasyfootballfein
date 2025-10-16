// routes/minileagues.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const rid = (p = 'mini') => `${p}_${crypto.randomUUID().replace(/-/g,'').slice(0,18)}`;

// Helper: fetch mini details (league, teams, scope)
async function loadMini(client, id) {
  const { rows: lr } = await client.query('SELECT * FROM ff_mini_league WHERE id = $1', [id]);
  if (!lr.length) return null;
  const league = lr[0];
  const { rows: tr } = await client.query(
    'SELECT * FROM ff_mini_league_team WHERE mini_league_id = $1 ORDER BY team_name NULLS LAST, league_id, team_id',
    [id]
  );
  const { rows: sr } = await client.query('SELECT * FROM ff_mini_scope WHERE mini_league_id = $1', [id]);
  return { ...league, teams: tr, scope: sr[0] || null };
}

// POST /api/minileagues  (create)
router.post('/', async (req, res) => {
  const {
    name,
    base = {},
    visibility = 'link',
    scoring = { profile: 'inherit' },
    members = [],
    scope = null,
  } = req.body || {};

  const id = rid('mini');
  const owner_member_id = (req.user && req.user.member_id) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO ff_mini_league
       (id, name, owner_member_id, base_type, base_platform, base_season, base_league_id, base_team_ref, visibility, scoring_profile_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        name || 'MiniLeague',
        owner_member_id,
        base.type || 'LEAGUE',
        base.platform || 'espn',
        Number(base.season),
        base.leagueId || null,
        base.baseTeamRef || null,
        visibility,
        scoring.profile || 'inherit',
      ]
    );

    for (const m of members) {
      await client.query(
        `INSERT INTO ff_mini_league_team
         (id, mini_league_id, platform, season, league_id, team_id, team_name, league_name, handle, member_id, is_base_team)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (mini_league_id, platform, season, league_id, team_id) DO NOTHING`,
        [
          rid('mlt'),
          id,
          m.platform || base.platform || 'espn',
          Number(m.season || base.season),
          String(m.leagueId),
          String(m.teamId),
          m.teamName || null,
          m.leagueName || null,
          m.handle || null,
          m.member_id || null,
          !!m.is_base_team,
        ]
      );
    }

    if (scope) {
      await client.query(
        `INSERT INTO ff_mini_scope
         (mini_league_id, week_start, week_end, include_positions, include_fas, fa_mode, fa_limit, use_ros)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (mini_league_id) DO UPDATE
         SET week_start=$2, week_end=$3, include_positions=$4, include_fas=$5, fa_mode=$6, fa_limit=$7, use_ros=$8`,
        [
          id,
          Number(scope.weekStart ?? scope.week_start ?? 1),
          Number(scope.weekEnd ?? scope.week_end ?? 18),
          scope.includePositions || null,
          !!(scope.includeFas ?? scope.include_fas),
          scope.fa_mode || scope.faMode || 'TOP',
          scope.fa_limit || scope.faLimit || null,
          !!(scope.use_ros ?? scope.useRos),
        ]
      );
    }

    await client.query('COMMIT');
    const out = await loadMini(client, id);
    res.status(201).json(out);
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('Create mini error', e);
    res.status(500).json({ ok: false, error: 'mini_create_failed' });
  } finally {
    client.release();
  }
});

// GET /api/minileagues (list by owner or all link/public)
router.get('/', async (req, res) => {
  const owner_member_id = (req.user && req.user.member_id) || null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ff_mini_league
       WHERE ($1::text IS NOT NULL AND owner_member_id = $1)
          OR visibility IN ('link','public')
       ORDER BY created_at DESC
       LIMIT 200`,
      [owner_member_id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'mini_list_failed' });
  }
});

// GET /api/minileagues/:id (details)
router.get('/:id', async (req, res) => {
  try {
    const client = await pool.connect();
    const mini = await loadMini(client, req.params.id);
    client.release();
    if (!mini) return res.status(404).json({ ok: false, error: 'mini_not_found' });
    res.json(mini);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'mini_get_failed' });
  }
});

// POST /api/minileagues/:id/scope (upsert)
router.post('/:id/scope', async (req, res) => {
  const id = req.params.id;
  const s = req.body || {};
  try {
    await pool.query(
      `INSERT INTO ff_mini_scope
       (mini_league_id, week_start, week_end, include_positions, include_fas, fa_mode, fa_limit, use_ros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (mini_league_id) DO UPDATE
       SET week_start=$2, week_end=$3, include_positions=$4, include_fas=$5, fa_mode=$6, fa_limit=$7, use_ros=$8`,
      [
        id,
        Number(s.weekStart ?? s.week_start ?? 1),
        Number(s.weekEnd ?? s.week_end ?? 18),
        s.includePositions || null,
        !!(s.includeFas ?? s.include_fas),
        s.fa_mode || s.faMode || 'TOP',
        s.fa_limit || s.faLimit || null,
        !!(s.use_ros ?? s.useRos),
      ]
    );
    const { rows } = await pool.query('SELECT * FROM ff_mini_scope WHERE mini_league_id = $1', [id]);
    res.json(rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'mini_scope_failed' });
  }
});

// POST /api/minileagues/:id/members (add or set)
router.post('/:id/members', async (req, res) => {
  const id = req.params.id;
  const { mode = 'add', members = [] } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (mode === 'set') {
      await client.query('DELETE FROM ff_mini_league_team WHERE mini_league_id = $1', [id]);
    }
    for (const m of members) {
      await client.query(
        `INSERT INTO ff_mini_league_team
         (id, mini_league_id, platform, season, league_id, team_id, team_name, league_name, handle, member_id, is_base_team)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (mini_league_id, platform, season, league_id, team_id) DO NOTHING`,
        [
          rid('mlt'),
          id,
          m.platform || 'espn',
          Number(m.season),
          String(m.leagueId),
          String(m.teamId),
          m.teamName || null,
          m.leagueName || null,
          m.handle || null,
          m.member_id || null,
          !!m.is_base_team,
        ]
      );
    }
    await client.query('COMMIT');
    const { rows } = await client.query(
      'SELECT * FROM ff_mini_league_team WHERE mini_league_id = $1 ORDER BY team_name NULLS LAST',
      [id]
    );
    res.json(rows);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ ok: false, error: 'mini_members_failed' });
  } finally {
    client.release();
  }
});

// DELETE /api/minileagues/:id/members  (body: {platform,season,leagueId,teamId})
router.delete('/:id/members', async (req, res) => {
  const id = req.params.id;
  const m = req.body || {};
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ff_mini_league_team
       WHERE mini_league_id=$1 AND platform=$2 AND season=$3 AND league_id=$4 AND team_id=$5`,
      [id, m.platform || 'espn', Number(m.season), String(m.leagueId), String(m.teamId)]
    );
    res.json({ ok: true, removed: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'mini_member_delete_failed' });
  }
});

// GET /api/minileagues/:id/standings?weekStart=&weekEnd=
router.get('/:id/standings', async (req, res) => {
  const id = req.params.id;
  const weekStart = Number(req.query.weekStart || req.query.ws || 1);
  const weekEnd   = Number(req.query.weekEnd   || req.query.we || 18);

  // NOTE: expects ff_team_weekly_points(platform, season, league_id, team_id, week, points)
  const sql = `
    WITH teams AS (
      SELECT id AS team_row_id, platform, season, league_id, team_id, team_name, league_name
      FROM ff_mini_league_team WHERE mini_league_id = $1
    ),
    weeks AS (SELECT generate_series($2::int, $3::int) AS week),
    mw AS (
      SELECT t.team_row_id, w.week,
             COALESCE(SUM(tp.points), 0) AS pts
      FROM teams t
      CROSS JOIN weeks w
      LEFT JOIN ff_team_weekly_points tp
        ON tp.platform = t.platform
       AND tp.season   = t.season
       AND tp.league_id= t.league_id
       AND tp.team_id  = t.team_id
       AND tp.week     = w.week
      GROUP BY t.team_row_id, w.week
    ),
    comp AS (
      SELECT a.team_row_id,
             SUM(a.pts) AS points_total,
             SUM(CASE WHEN a.pts >  b.pts THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN a.pts =  b.pts THEN 1 ELSE 0 END) - COUNT(DISTINCT a.week) AS ties,
             SUM(CASE WHEN a.pts <  b.pts THEN 1 ELSE 0 END) AS losses
      FROM mw a
      JOIN mw b ON a.week = b.week
      GROUP BY a.team_row_id
    )
    SELECT t.team_row_id, t.team_name, t.league_name, t.league_id, t.team_id,
           c.points_total, c.wins, c.losses, GREATEST(c.ties,0) AS ties
    FROM teams t
    LEFT JOIN comp c ON c.team_row_id = t.team_row_id
    ORDER BY c.points_total DESC NULLS LAST, t.team_name ASC NULLS LAST;
  `;
  try {
    const { rows } = await pool.query(sql, [id, weekStart, weekEnd]);
    res.json({ weekStart, weekEnd, rows });
  } catch (e) {
    console.error('standings error', e);
    res.status(500).json({ ok: false, error: 'mini_standings_failed' });
  }
});

module.exports = router;
