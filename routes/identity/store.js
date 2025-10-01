// routes/identity/store.js
// Shared ephemeral store for login options & challenges.
// Replace with Redis in production.

const crypto = require('crypto');
const now = () => Date.now();
const rid = (p) => `${p}_${crypto.randomBytes(16).toString('hex')}`;

const OPTION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CHAL_TTL_MS   =  5 * 60 * 1000; // 5 minutes

const options = new Map();   // option_id -> { member_id, kind:'email'|'phone', identifier, exp }
const challenges = new Map();// challenge_id -> { member_id, identifier, channel, code_hash, exp }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createOption({ member_id, kind, identifier }) {
  const option_id = rid('opt');
  options.set(option_id, { member_id, kind, identifier, exp: now() + OPTION_TTL_MS });
  return option_id;
}

function getOption(option_id) {
  const o = options.get(option_id);
  if (!o || o.exp < now()) return null;
  return o;
}

function createChallenge({ member_id, identifier, channel, code }) {
  const challenge_id = rid('ch');
  challenges.set(challenge_id, {
    member_id, identifier, channel,
    code_hash: sha(code),
    exp: now() + CHAL_TTL_MS
  });
  return challenge_id;
}

function consumeChallenge(challenge_id, code) {
  const c = challenges.get(challenge_id);
  if (!c || c.exp < now()) return { ok:false, error:'challenge_expired' };
  if (sha(code) !== c.code_hash) return { ok:false, error:'code_mismatch' };
  challenges.delete(challenge_id);
  return { ok:true, data:c };
}

module.exports = {
  createOption, getOption,
  createChallenge, consumeChallenge,
};
