// routers/sleeperRouter.js
const express = require('express');
const router = express.Router();

/**
 * Sleeper Router
 * Scope: /api/platforms/sleeper
 *
 * Start minimal (alive + echo). Add real endpoints as you need:
 *   GET /leagues?season=2025
 *   GET /leagues/:leagueId/teams
 *   GET /leagues/:leagueId/roster/:teamId
 */

router.get('/__alive', (_req, res) => {
  res.json({ ok: true, scope: '/api/platforms/sleeper' });
});

// Example placeholder (so you can verify the route mounts correctly)
router.get('/echo', (req, res) => {
  res.json({
    ok: true,
    q: req.query || {},
    note: 'Sleeper echo endpoint',
  });
});

module.exports = router;
