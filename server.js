// src/routes/platforms.js
// Aggregates non-ESPN platform routers under /api/platforms/*
// ESPN is mounted separately in server.js with auth gating:
//   app.use('/api/platforms/espn', requireEspnAuth, require('./src/routes/platforms-espn'))

const express = require('express');
const path = require('path');

const router = express.Router();

/**
 * Small interop so we can require routers whether they're CJS or ESM.
 * - module.exports = router            -> function
 * - module.exports = { router }        -> { router }
 * - export default router              -> { default }
 */
function requireRouter(p) {
  const mod = require(p);
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.router === 'function') return mod.router;
  if (mod && typeof mod.default === 'function') return mod.default;
  const keys = mod && typeof mod === 'object' ? Object.keys(mod) : String(mod);
  throw new TypeError(`Expected an Express router from ${p} but got ${typeof mod} (${keys})`);
}

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms', note: 'ESPN mounted separately' })
);

// 👇 Mount NON-ESPN platforms here
router.use(
  '/sleeper',
  requireRouter(path.join(__dirname, '../../routers/sleeperRouter'))
);

router.use(
  '/health',
  requireRouter(path.join(__dirname, '../../routers/healthRouter'))
);

// If any code still hits /api/platforms/espn here, make it obvious it's the wrong place.
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
      // Reminder: ESPN is mounted in server.js at /api/platforms/espn
      '/api/platforms/sleeper',
      '/api/platforms/health',
    ],
  });
});

module.exports = router;
