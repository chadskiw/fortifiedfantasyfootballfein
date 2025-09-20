CHECK THIS OUT
// TRUE_LOCATION: api/platforms/index.js
// IN_USE: FALSE
// api/platforms/index.js
// Returns platform adapters. No Express router logic here.

const path = require('path');

function loadLocal(relPath) {
  return require(path.join(__dirname, relPath));
}

const ADAPTERS = {
  espn:    () => loadLocal('./espn'),     // -> api/platforms/espn/index.js (or espn.js)
  /*
  sleeper: () => loadLocal('./sleeper'),
  health:  () => loadLocal('./health'),
  */
};

function getAdapter(name) {
  const key = String(name || '').toLowerCase();
  const factory = ADAPTERS[key];
  if (!factory) throw new Error(`Unknown platform adapter: ${name}`);
  return factory(); // return the adapter object (functions), not a router
}

module.exports = { getAdapter };
