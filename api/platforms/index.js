// api/platforms/index.js
// Adapter registry: getAdapter('espn' | 'sleeper' | 'yahoo' | 'mfl')

const espn = require('./espn');
const sleeper = require('./sleeper');
const yahoo = require('./yahoo');
const mfl = require('./mfl');

const REGISTRY = {
  espn,
  sleeper,
  yahoo,
  mfl,
};

function getAdapter(platform) {
  const key = String(platform || '').toLowerCase();
  const adapter = REGISTRY[key];
  if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
  return adapter;
}

module.exports = { getAdapter };
