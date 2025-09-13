// src/api/fein-auth/index.js
const express = require('express');
const router = express.Router();

// sanity check
router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// Mount Express routers
const path = require('path');
router.use(
  '/espn',
  require(path.join(__dirname, '../../routers/espnRouter'))
);
router.use(
  '/sleeper',
  require(path.join(__dirname, require('./src/routers/sleeperRouter'))));

router.use(
  '/health',
  require(path.join(__dirname,  require('./src/routers/healthRouter'))));
 
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
