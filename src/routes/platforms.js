// src/routes/platforms.js
const express = require('express');
const router = express.Router();

// Sub-routers live in /routers (one level up from /src)
const espnRouter    = require('../routers/espnRouter');
const sleeperRouter = require('../routers/sleeperRouter');

// Health/help for this mount
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    hint: 'Try /espn/leagues/:leagueId/teams?season=2025 or /espn/leagues/:leagueId/scoreboard?season=2025&week=2',
  });
});

// Debug “who am I” endpoint to confirm the correct router file is mounted
router.get('/__whoami', (_req, res) => {
  res.json({ ok: true, file: __filename, mounted: ['/espn', '/sleeper'] });
});

// Mount per-platform routers
router.use('/espn', espnRouter);
router.use('/sleeper', sleeperRouter);

// (Optional) 404 for the /api/platforms scope only
router.use((_req, res) => res.status(404).json({ ok: false, error: 'platform route not found' }));

module.exports = router;
