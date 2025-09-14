// src/routes/platforms.js
// Aggregates NON-ESPN platform routers under /api/platforms/*
// ESPN is mounted separately in server.js with auth gating:
//   app.use('/api/platforms/espn', requireEspnAuth, require('./src/routes/platforms-espn'))

const express = require('express');
const path = require('path');

const router = express.Router();

// Simple alive
router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms', note: 'ESPN mounted separately' })
);

// ✅ Mount NON-ESPN platform routers with plain CommonJS require.
/*    Avoid wrappers/helpers that might return objects or use import().
router.use('/health',  require(path.join(__dirname, '../../routersRouter')));
router.use('/sleeper', require(path.join(__dirname, '../../routers/sleeperRouter')));
*/
// Guard: if someone hits /api/platforms/espn here, make it obvious this is the wrong place.
router.use('/espn', (_req, res) => {
  res.status(404).json({
    ok: false,
    error: 'ESPN routes are mounted separately with auth. Use /api/platforms/espn/*',
  });
});

// Routes index for quick visibility
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
