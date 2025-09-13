// src/routes/platforms.js
const express = require('express');
const loadRouter = require('../util/requireRouter');
const router = express.Router();

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// Normalize routers regardless of CJS/ESM style
router.use('/espn',    loadRouter('../../routers/espnRouter'));
router.use('/sleeper', loadRouter('../../routers/sleeperRouter'));
router.use('/health',  loadRouter('../../routers/healthRouter'));

router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      '/api/platforms/espn',
      '/api/platforms/sleeper',
      '/api/platforms/health',
    ],
  });
});

module.exports = router;
