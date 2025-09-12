// src/platforms/index.js
const espn    = require('./espn');
const sleeper = require('./sleeper');
const yahoo   = require('./yahoo');
const mfl     = require('./mfl');

const registry = { espn, sleeper, yahoo, mfl };

function getAdapter(name) {
  const key = String(name || '').toLowerCase();
  const adapter = registry[key];
  if (!adapter) throw new Error(`Unknown platform: ${name}`);
  return adapter;
}

module.exports = { getAdapter, registry };
