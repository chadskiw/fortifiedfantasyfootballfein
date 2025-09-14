// src/api/platforms/index.js
const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);

// Helper: normalize whatever require() returns into a router function
function asMiddleware(mod, label) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default; // ESM default
  if (mod && typeof mod.router === 'function') return mod.router;   // named export
  throw new TypeError(
    `${label} is not a valid Express router. ` +
    `Export it as "module.exports = router" (CJS) or "export default router" (ESM).`
  );
}

// Require routers (CJS preferred)
const espn = asMiddleware(
  require(path.join(__dirname, '../../routers/espnRouter')),
  'espnRouter'
);
/*
const sleeper = asMiddleware(
  require(path.join(__dirname, '../../routers/sleeperRouter')),
  'sleeperRouter'
);
const health = asMiddleware(
  require(path.join(__dirname, '../../routers/healthRouter')),
  'healthRouter'
);
*/
// Mount them
router.use('/espn', espn);
/*
router.use('/sleeper', sleeper);
router.use('/health', health);
*/
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
