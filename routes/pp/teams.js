// routes/pp/teams.js
// Mount with: app.use('/api/pp', require('./routes/pp/teams'));

const express = require('express');
let db = require('../../src/db/pool');
let pool = db.pool || db;

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pp/teams] pg pool missing/invalid import');
}

const router = express.Router();

/**
 * GET /api/pp/teams
 * Query params:
 *  - sport  (default: 'ffl')
 *  - season (required-ish, defaults to current year)
 *  - platform (optional, e.g., '018' for ESPN)
 *  - handle | member_id (optional filters to "my" entries)
 *  - visibility (default 'public')
 *  - status (default 'active')
 *
 * Returns a unified array used by FEIN pools:
 *  [{season, leagueId, teamId, teamName, leagueName, leagueSize, logo}]
 */
router.get('/teams', async (req, res) => {
  try {
    const sport     = String(req.query.sport || 'ffl').toLowerCase();
    const season    = Number(req.query.season || new Date().getUTCFullYear());
    const platform  = req.query.platform ? String(req.query.platform) : null; // '018' ESPN
    const handle    = req.query.handle ? String(req.query.handle) : null;
    const memberId  = req.query.member_id ? String(req.query.member_id) : null;
    const visibility= req.query.visibility ? String(req.query.visibility) : 'public';
    const status    = req.query.status ? String(req.query.status) : 'active';

    // Only ffl table for now; easy to extend later
    if (sport !== 'ffl') {
      return res.status(400).json({ ok:false, error:'Unsupported sport for this endpoint' });
    }

    const conds = ['season = $1', 'visibility = $2', 'status = $3'];
    const params = [season, visibility, status];
    let p = 4;

    if (platform) { conds.push(`platform = $${p++}`); params.push(platform); }
    if (handle)   { conds.push(`handle = $${p++}`);   params.push(handle); }
    if (memberId) { conds.push(`member_id = $${p++}`);params.push(memberId); }

    // NOTE: ff_sport_ffl holds one row per (leagueId, teamId) we've ingested.
    // Pull the fields needed for pools and normalize names.
    const sql = `
      SELECT
        season,
        league_id::text  AS "leagueId",
        team_id::text    AS "teamId",
        COALESCE(team_name,'Team')      AS "teamName",
        COALESCE(league_name,'League')  AS "leagueName",
        COALESCE(league_size,0)         AS "leagueSize",
        COALESCE(team_logo_url,'')      AS "logo"
      FROM ff_sport_ffl
      WHERE ${conds.join(' AND ')}
      ORDER BY season DESC, league_id::text, team_id::text
    `;

    const { rows } = await pool.query(sql, params);

    return res.json({ ok:true, season, sport, count: rows.length, teams: rows });
  } catch (err) {
    console.error('[pp/teams] error', err);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
