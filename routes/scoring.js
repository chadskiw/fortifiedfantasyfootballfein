// routes/scoring.js
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();
router.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Leagues for a season */
router.get('/api/scoring/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season || new Date().getFullYear());
    const sql = `
      SELECT DISTINCT league_id::text AS league_id, league_name
      FROM ff_sport_ffl
      WHERE season = $1
      ORDER BY league_name NULLS LAST, league_id
    `;
    const { rows } = await pool.query(sql, [season]);
    res.json({ ok: true, season, leagues: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** Teams in a league */
router.get('/api/scoring/teams', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.league_id || '');
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing season/league_id' });

    const sql = `
      SELECT team_id, team_name
      FROM ff_sport_ffl
      WHERE season = $1 AND league_id = $2
      ORDER BY team_id
    `;
    const { rows } = await pool.query(sql, [season, leagueId]);
    res.json({ ok:true, season, leagueId, teams: rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/** Rebuild weekly totals for selected week/scoring (optionally subset of team_ids) */
router.post('/api/scoring/rebuild-weekly', async (req, res) => {
  try {
    const { season, league_id, week, scoring, team_ids } = req.body || {};
    if (!season || !league_id || !week || !scoring)
      return res.status(400).json({ ok:false, error:'missing season/league_id/week/scoring' });

    const { rows } = await pool.query(
      `SELECT ff_rebuild_team_weekly_points($1,$2,$3,$4,$5::int[]) AS changed`,
      [season, String(league_id), week, String(scoring).toUpperCase(), team_ids || null]
    );
    res.json({ ok:true, changed: rows?.[0]?.changed ?? 0 });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/** Refresh the cache for a league (latest week per team/scoring) */
router.post('/api/scoring/refresh-cache', async (req, res) => {
  try {
    const { season, league_id, scoring } = req.body || {};
    if (!season || !league_id)
      return res.status(400).json({ ok:false, error:'missing season/league_id' });

    const { rows } = await pool.query(
      `SELECT ff_refresh_team_points_cache($1,$2,$3) AS changed`,
      [season, String(league_id), scoring ? String(scoring).toUpperCase() : null]
    );
    res.json({ ok:true, changed: rows?.[0]?.changed ?? 0 });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

module.exports = router;
