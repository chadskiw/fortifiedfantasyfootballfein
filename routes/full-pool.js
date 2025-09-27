// routes/espn-poll.js
const express = require('express');
const pool = require('../src/db/pool');
const router = express.Router();

// GET /api/platforms/espn/poll?season=2025&size=10&sport=ffl
router.get('/poll', async (req, res) => {
  const season = Number(req.query.season) || new Date().getUTCFullYear();
  const size   = Number(req.query.size)   || 10;
  const sport  = String(req.query.sport || 'ffl').toLowerCase(); // ffl,fhl,fba,flb,fwnba
  const table  = `ff_sport_${sport}`;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        season,
        league_id   AS "leagueId",
        team_id     AS "teamId",
        team_name   AS "teamName",
        league_name AS "leagueName",
        COALESCE(league_size, $2) AS "leagueSize",
        team_logo_url AS "logo",
        (scoring_json->>'weekPts')::numeric    AS "weekPts",
        (scoring_json->>'seasonPts')::numeric  AS "seasonPts",
        (scoring_json->>'rank')::numeric       AS "rank",
        (scoring_json->>'powerRank')::numeric  AS "powerRank"
      FROM "${table}"
      WHERE season = $1
      ORDER BY league_id, team_id
      `,
      [season, size]
    );

    // shape to the client’s expected structure
    const mapped = rows.map(r => ({
      season:     Number(r.season),
      leagueId:   String(r.leagueId),
      teamId:     String(r.teamId),
      teamName:   r.teamName || 'Team',
      leagueName: r.leagueName || 'League',
      leagueSize: Number(r.leagueSize || size),
      logo:       r.logo || '',
      weekPts:    Number(r.weekPts || 0),
      seasonPts:  Number(r.seasonPts || 0),
      rank:       r.rank == null ? null : Number(r.rank),
      powerRank:  r.powerRank == null ? null : Number(r.powerRank)
    }));

    res.json({ ok:true, rows: mapped });
  } catch (e) {
    console.error('[poll]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
