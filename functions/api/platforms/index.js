// functions/api/platforms/index.js
const espn = require('./espn/adapter');
const sleeper = require('./sleeper/adapter');

const REGISTRY = {
  espn,
  sleeper,
};

function getAdapter(name) {
  const key = String(name || '').toLowerCase();
  const api = REGISTRY[key];
  if (!api) throw new Error(`Unknown platform: ${name}`);
  return api;
}

module.exports = { getAdapter };
