// routers/sleeperRouter.js  (CommonJS)
const express = require('express');
const router = express.Router();

// health
router.get('/__alive', (_req, res) => {
  res.json({ ok: true, scope: '/api/platforms/sleeper' });
});

// example: GET /api/platforms/sleeper/leagues?season=2025
router.get('/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    // TODO: wire to your sleeper service/adapters
    res.json({
      ok: true,
      platform: 'sleeper',
      season,
      leagues: [], // fill in
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed' });
  }
});

// example: GET /api/platforms/sleeper/leagues/:leagueId/teams
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { leagueId } = req.params;
    // TODO: fetch teams from Sleeper
    res.json({ ok: true, platform: 'sleeper', leagueId, teams: [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed' });
  }
});

module.exports = router;
