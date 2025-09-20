// TRUE_LOCATION: src/routers/sleeperRouter.js
// IN_USE: FALSE
// routers/sleeperRouter.js
const express = require('express');
const router = express.Router();

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms/sleeper' })
);

// e.g. GET /api/platforms/sleeper/leagues?season=2025
router.get('/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    res.json({ ok: true, platform: 'sleeper', season, leagues: [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed' });
  }
});

module.exports = router;  // <-- important
