// TRUE_LOCATION: src/routes/ffPoints.js
// IN_USE: Read weekly points + "season totals" (stored as week=1) from ff_team_weekly_points.
//         Provides raw rows, a shaped "totals" list, and a compact map keyed by <leagueId>:<teamId>.

const express = require('express');

/** @typedef {import('pg').Pool} Pool */
/** @param {{ db: Pool }} deps */
module.exports = function ffPointsRouter(deps) {
  const { db } = deps;
  const router = express.Router();

  // ---------------- utils ----------------
  const ALIAS_WEEK_FOR_SEASON_TOTALS = 1; // <- you store Season totals as week=1

  function toInt(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  function bad(res, msg, code = 400) {
    return res.status(code).json({ error: msg });
  }

  // ---------------- routes ----------------

  /**
   * GET /api/ff/team-weekly-points?season=2025&week=1&leagueId=1888700373&teamId=1&limit=200&offset=0
   * Returns raw rows from ff_team_weekly_points.
   */
  router.get('/team-weekly-points', async (req, res) => {
    try {
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
   * Season totals are stored in ff_team_weekly_points as week = ALIAS_WEEK_FOR_SEASON_TOTALS (1).
   * Returns a list sorted by points desc.
   */
  router.get('/team-season-totals', async (req, res) => {
    try {
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
   * Returns { "<leagueId>:<teamId>": <points> } for Season totals (week alias).
   */
  router.get('/team-season-total-map', async (req, res) => {
    try {
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

  return router;
};
