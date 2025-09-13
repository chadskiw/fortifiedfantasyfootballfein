// src/util/requireRouter.js
module.exports = function requireRouter(pathToModule) {
  const mod = require(pathToModule);

  // Express Router candidates, in priority order
  if (typeof mod === 'function') return mod;                 // module.exports = router
  if (mod && typeof mod.router === 'function') return mod.router; // { router }
  if (mod && typeof mod.default === 'function') return mod.default; // export default router
// src/util/requireRouter.js
module.exports = function requireRouter(p) {
  const mod = require(p);
  if (typeof mod === 'function') return mod;                  // module.exports = router
  if (mod && typeof mod.router === 'function') return mod.router;
  if (mod && typeof mod.default === 'function') return mod.default; // export default router
  const keys = mod && typeof mod === 'object' ? Object.keys(mod) : String(mod);
  throw new TypeError(`Expected router function from ${p} but got ${typeof mod} (${keys})`);
};

  // Helpful diagnostics if it's not a Router
  const keys = mod && typeof mod === 'object' ? Object.keys(mod) : String(mod);
  throw new TypeError(
    `Expected an Express router function from ${pathToModule} but got: ${typeof mod} with keys/value: ${keys}`
  );
};
