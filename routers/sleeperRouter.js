// routers/sleeperRouter.js
const express = require('express');
const router = express.Router();

/**
 * Sleeper Platform Router
 * Scope: /api/platforms/sleeper
 */

router.get('/__alive', (_req, res) => {
  res.json({ ok: true, scope: '/api/platforms/sleeper' });
});

// Example endpoint: GET /api/platforms/sleeper/leagues?season=2025
router.get('/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    // TODO: hook into your Sleeper service/adapter
    res.json({
      ok: true,
      platform: 'sleeper',
      season,
      leagues: [], // return actual data here
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed' });
  }
});

// Example endpoint: GET /api/platforms/sleeper/leagues/:leagueId/teams
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { leagueId } = req.params;
    // TODO: fetch teams from Sleeper
    res.json({
      ok: true,
      platform: 'sleeper',
      leagueId,
      teams: [], // return actual teams here
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed' });
  }
});

module.exports = router;
