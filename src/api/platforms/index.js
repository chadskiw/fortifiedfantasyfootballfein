// src/api/platforms/index.js
const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/__alive', (_req, res) =>
  res.json({ ok: true, scope: '/api/platforms' })
);
const espnMod = require(path.join(__dirname, '../../src/routers/espnRouter'));
console.log('[espnRouter require]', {
  type: typeof espnMod,
  keys: espnMod && Object.keys(espnMod),
  isFunc: typeof espnMod === 'function',
  hasDefaultFunc: !!(espnMod && typeof espnMod.default === 'function'),
  hasRouterFunc: !!(espnMod && typeof espnMod.router === 'function'),
});

// Helper: normalize whatever require() returns into a router function
function asMiddleware(mod, label) {
  // express.Router() returns a function (middleware)
  if (typeof mod === 'function') return mod;

  // ESM default export of the router function
  if (mod && typeof mod.default === 'function') return mod.default;

  // Named export like { router }
  if (mod && typeof mod.router === 'function') return mod.router;

  // Express Router instance object (has .handle)
  if (mod && typeof mod.handle === 'function') return mod;

  throw new TypeError(
    `${label} is not a valid Express router. ` +
    `Export it as "module.exports = router" (CJS) or "export default router" (ESM).`
  );
}


// Require routers (CJS preferred)
const espn = asMiddleware(
  require(path.join(__dirname, '../../src/routers/espnRouter')),
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
