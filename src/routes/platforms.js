// TRUE_LOCATION: src/routes/platforms.js
// IN_USE: TRUE
// src/routes/platforms.js
// Aggregates NON-ESPN platform routers under /api/platforms/*
// ESPN is mounted separately in server.js with auth gating.

const express = require('express');
const path = require('path');

const router = express.Router();

// Simple alive
router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms', note: 'ESPN mounted separately' })
);

// 🚫 IMPORTANT: Avoid helpers that wrap/transform routers.
// ✅ Mount CommonJS routers directly with require().
/*
router.use('/health', require(path.join(__dirname, '../../routers/healthRouter')));
router.use('/sleeper', require(path.join(__dirname, '../../routers/sleeperRouter')));
*/
// Guard: if someone hits /api/platforms/espn here, make it obvious this is the wrong place.
router.use('/espn', (_req, res) => {
  res.status(404).json({
    ok: false,
    error: 'ESPN routes are mounted separately with auth. Use /api/platforms/espn/*',
  });
});

router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      //'/api/platforms/sleeper',
      //'/api/platforms/health',
      // Reminder: /api/platforms/espn is mounted in server.js with requireEspnAuth
    ],
  });
}); 

module.exports = router;
