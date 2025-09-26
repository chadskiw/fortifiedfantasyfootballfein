// TRUE_LOCATION: src/util/anagram.js
// IN_USE: TRUE
// src/anagram.js
// Server-side "anagram" builder (seeded HMAC over ff_sess)

const crypto = require('crypto');
const SEED = process.env.FF_CODE_SEED || 'dev-seed-only-change-me';

/** Build a deterministic 6-char code from ff_sess (+ seed). */
function buildCodeFromCookie(ffSess, length = 6) {
  if (!ffSess) throw new Error('Missing ff_sess cookie');
  const mac = crypto.createHmac('sha256', SEED).update(String(ffSess)).digest('hex');
  return mac.slice(0, length).toUpperCase();
}

/** Build a new “retry” code using an extra salt (e.g., timestamp) */
function buildSeededCode(ffSess, salt, length = 6) {
  if (!ffSess) throw new Error('Missing ff_sess cookie');
  const mac = crypto.createHmac('sha256', SEED)
    .update(String(ffSess))
    .update('|')
    .update(String(salt))
    .digest('hex');
  return mac.slice(0, length).toUpperCase();
}

module.exports = { buildCodeFromCookie, buildSeededCode };
