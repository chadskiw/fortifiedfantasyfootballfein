// TRUE_LOCATION: routes/identity.js
// IN_USE: TRUE
// routes/identity.js
// Helpers for FF identity cookie & codes (CommonJS)

const COOKIE_NAME = 'ff-interacted';
const HEADER_NAME = 'x-ff-id';
const CODE_RE = /^[A-Z0-9]{8}$/;

// Generate 8-char A–Z0–9 code (crypto-safe)
function makeCode(len = 8) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const { randomBytes } = require('crypto');
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CH[buf[i] % CH.length];
  return out;
}

// Compute cookie options based on env + request
function cookieOpts(req) {
  const secure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';

  // Optional: set a parent domain for subdomain sharing
  const domain = process.env.FF_COOKIE_DOMAIN || undefined; // e.g. ".fortifiedfantasy.com"

  return {
    httpOnly: false,        // readable by frontend (you want the browser to send it with uploads/forms)
    sameSite: 'Lax',
    secure,
    domain,
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 365 * 2, // 2 years
  };
}

// Core helper used by your routes: ensures the cookie exists/valid
function ensureInteracted(req, res) {
  const hdr = (req.get(HEADER_NAME) || '').trim().toUpperCase();
  const ck  = (req.cookies?.[COOKIE_NAME] || '').trim().toUpperCase();

  // Prefer a valid cookie
  if (ck && CODE_RE.test(ck)) {
    // If a (different) valid header shows up, ignore it; the cookie is our source of truth.
    return { code: ck, source: 'cookie' };
  }

  // If no/invalid cookie, but a valid header exists, adopt it and set cookie
  if (hdr && CODE_RE.test(hdr)) {
    res.cookie(COOKIE_NAME, hdr, cookieOpts(req));
    return { code: hdr, source: 'header' };
  }

  // Otherwise generate a new code and set cookie
  const fresh = makeCode(8);
  res.cookie(COOKIE_NAME, fresh, cookieOpts(req));
  return { code: fresh, source: 'generated' };
}

module.exports = { makeCode, ensureInteracted, COOKIE_NAME, HEADER_NAME, CODE_RE };
