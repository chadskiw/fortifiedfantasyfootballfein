// src/api/fein-auth/index.js
const express = require('express');
const path = require('path');

const router = express.Router();

// sanity check
router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// ✅ Mount Express routers (no nested require calls)
router.use('/espn',    require(path.join(__dirname, '../routers/espnRouter')));
/*
router.use('/sleeper', require(path.join(__dirname, '../../routers/sleeperRouter')));
router.use('/health',  require(path.join(__dirname, '../../routers/healthRouter')));
*/
// optional helper
router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      '/api/platforms/espn',
      /*
      '/api/platforms/sleeper',
      '/api/platforms/health',
      */
    ],
  });
});

module.exports = router;
