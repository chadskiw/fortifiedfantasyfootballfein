// TRUE_LOCATION: src/routes/ffPoints.js
// Reads weekly points and "season totals" (stored as week=1) from ff_team_weekly_points.

const express = require('express');
const pool = require('../src/db/pool'); // <-- your shared Pool instance (fallback)

/** @typedef {import('pg').Pool} Pool */
/** @param {{ db?: Pool }} deps */
module.exports = function ffPointsRouter(deps = {}) {
  // prefer injected pool; otherwise use shared ../db/pool
  const db = deps.db || pool;

  const router = express.Router();
  const ALIAS_WEEK_FOR_SEASON_TOTALS = 1; // Season totals live at week=1

  // ------- utils -------
  const toInt = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const ensureDb = (res) => {
    if (!db || typeof db.query !== 'function') {
      res.status(500).json({ error: 'db_not_initialized' });
      return false;
    }
    return true;
  };

  /**
   * GET /api/ff/team-weekly-points?season=2025&week=1&leagueId=...&teamId=...&limit=200&offset=0
   */
  router.get('/team-weekly-points', async (req, res) => {
    try {
      if (!ensureDb(res)) return;

      const season   = toInt(req.query.season);
      const week     = toInt(req.query.week);
      const leagueId = req.query.leagueId ? String(req.query.leagueId) : undefined;
      const teamId   = req.query.teamId != null ? toInt(req.query.teamId) : undefined;

      if (!season) return bad(res, 'season is required');
      if (!week)   return bad(res, 'week is required');

      const limit  = Math.min(toInt(req.query.limit, 500), 1000);
      const offset = Math.max(toInt(req.query.offset, 0), 0);

      const where = ['season = $1', 'week = $2'];
      const params = [season, week];
      if (leagueId) { params.push(leagueId); where.push(`league_id = $${params.length}`); }
      if (Number.isFinite(teamId)) { params.push(teamId); where.push(`team_id = $${params.length}`); }

      const sql = `
        SELECT season, league_id, team_id, week, team_name,
               points, starters, scoring, created_at, updated_at
          FROM ff_team_weekly_points
         WHERE ${where.join(' AND ')}
         ORDER BY league_id, team_id, points DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2};
      `;
      params.push(limit, offset);

      const q = await db.query(sql, params);
      res.set('Cache-Control', 'no-store');
      return res.json({ rows: q.rows, count: q.rowCount });
    } catch (err) {
      console.error('team-weekly-points error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  /**
   * GET /api/ff/team-season-totals?season=2025[&leagueId=...&teamId=...]
   * Season totals are stored at week=ALIAS_WEEK_FOR_SEASON_TOTALS (1).
   */
  router.get('/team-season-totals', async (req, res) => {
    try {
      if (!ensureDb(res)) return;

      const season   = toInt(req.query.season);
      const leagueId = req.query.leagueId ? String(req.query.leagueId) : undefined;
      const teamId   = req.query.teamId != null ? toInt(req.query.teamId) : undefined;

      if (!season) return bad(res, 'season is required');

      const where = ['season = $1', 'week = $2'];
      const params = [season, ALIAS_WEEK_FOR_SEASON_TOTALS];
      if (leagueId) { params.push(leagueId); where.push(`league_id = $${params.length}`); }
      if (Number.isFinite(teamId)) { params.push(teamId); where.push(`team_id = $${params.length}`); }

      const sql = `
        SELECT season, league_id, team_id, week, team_name, points, scoring
          FROM ff_team_weekly_points
         WHERE ${where.join(' AND ')}
         ORDER BY points DESC;
      `;

      const q = await db.query(sql, params);
      res.set('Cache-Control', 'no-store');
      return res.json({ rows: q.rows, aliasWeek: ALIAS_WEEK_FOR_SEASON_TOTALS });
    } catch (err) {
      console.error('team-season-totals error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  /**
   * GET /api/ff/team-season-total-map?season=2025
   * Returns { "<leagueId>:<teamId>": <points> } for Season totals.
   */
  router.get('/team-season-total-map', async (req, res) => {
    try {
      if (!ensureDb(res)) return;

      const season = toInt(req.query.season);
      if (!season) return bad(res, 'season is required');

      const sql = `
        SELECT league_id, team_id, points
          FROM ff_team_weekly_points
         WHERE season = $1 AND week = $2;
      `;
      const q = await db.query(sql, [season, ALIAS_WEEK_FOR_SEASON_TOTALS]);

      const map = {};
      for (const r of q.rows) map[`${r.league_id}:${r.team_id}`] = Number(r.points);

      res.set('Cache-Control', 'no-store');
      return res.json({ season, week: ALIAS_WEEK_FOR_SEASON_TOTALS, totals: map });
    } catch (err) {
      console.error('team-season-total-map error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  /**
   * GET /api/ff/team-season-points?season=2025[&leagueId=...&teamId=...&scoring=PPR,HALF]
   * Aggregates ff_team_weekly_points across all weeks per season/league/team/scoring.
   */
  router.get('/team-season-points', async (req, res) => {
    try {
      if (!ensureDb(res)) return;

      const season   = toInt(req.query.season);
      const leagueId = req.query.leagueId ? String(req.query.leagueId) : undefined;
      const teamId   = req.query.teamId != null ? toInt(req.query.teamId) : undefined;

      if (!season) return bad(res, 'season is required');

      let scoringList = null;
      if (req.query.scoring) {
        scoringList = String(req.query.scoring)
          .split(/[ ,]+/)
          .map(s => s.trim().toUpperCase())
          .filter(Boolean);
        if (!scoringList.length) scoringList = null;
      }

      const where = ['season = $1'];
      const params = [season];
      if (leagueId) { params.push(leagueId); where.push(`league_id = $${params.length}`); }
      if (Number.isFinite(teamId)) { params.push(teamId); where.push(`team_id = $${params.length}`); }
      if (scoringList) { params.push(scoringList); where.push(`UPPER(scoring) = ANY($${params.length})`); }

      const sql = `
        SELECT
          season,
          league_id::text AS league_id,
          team_id,
          UPPER(scoring) AS scoring,
          COUNT(*)       AS weeks,
          SUM(points)::numeric AS points,
          ARRAY_AGG(DISTINCT week ORDER BY week) AS weeks_covered,
          MIN(created_at) AS first_recorded,
          MAX(updated_at) AS last_updated
        FROM ff_team_weekly_points
        WHERE ${where.join(' AND ')}
        GROUP BY season, league_id::text, team_id, UPPER(scoring)
        ORDER BY league_id::text, team_id, UPPER(scoring);
      `;

      const q = await db.query(sql, params);
      res.set('Cache-Control', 'no-store');
      return res.json({ rows: q.rows, count: q.rowCount });
    } catch (err) {
      console.error('team-season-points error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  return router;
};
