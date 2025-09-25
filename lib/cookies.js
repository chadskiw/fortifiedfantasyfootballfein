// src/lib/cookies.js
// Centralized cookie helpers for Fortified Fantasy.
//
// - ff_sid: HttpOnly session cookie (server-trusted)
// - ff_member: readable member id cookie (client UI convenience)
// - espn_s2: sensitive; clear immediately after attestation
//
// Notes:
// • In production we set `secure: true`; on localhost it auto-falls back.
// • To share cookies across subdomains (e.g., app.example.com & www.example.com),
//   set env FF_COOKIE_DOMAIN=".example.com". If unset, cookies bind to current host.

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
const COOKIE_DOMAIN = process.env.FF_COOKIE_DOMAIN || undefined;

// Base options used for all cookies we set/clear
function baseOpts() {
  return {
    path: '/',
    sameSite: 'lax',
    secure: isProd,         // secure in prod; auto false on localhost
    domain: COOKIE_DOMAIN,  // undefined by default (binds to host)
  };
}

// ---- Low-level primitives ---------------------------------------------------

/**
 * Set a cookie with sane defaults. Overridable via opts.
 * @param {import('express').Response} res
 * @param {string} name
 * @param {string} value
 * @param {object} [opts]
 */
function setCookie(res, name, value, opts = {}) {
  const o = { ...baseOpts(), ...opts };
  res.cookie(name, value, o);
}

/**
 * Clear a cookie (must match path/domain/samesite used when setting).
 * @param {import('express').Response} res
 * @param {string} name
 * @param {object} [opts]
 */
function clearCookie(res, name, opts = {}) {
  const o = { ...baseOpts(), ...opts };
  res.clearCookie(name, o);
}

/**
 * Read a cookie off the request (requires cookie-parser middleware).
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|undefined}
 */
function readCookie(req, name) {
  return req?.cookies?.[name];
}

// ---- High-level helpers -----------------------------------------------------

/**
 * HttpOnly session cookie used by the server to authenticate requests.
 * @param {import('express').Response} res
 * @param {string} sessionId
 * @param {object} [opts]
 */
function setSessionCookie(res, sessionId, opts = {}) {
  setCookie(res, 'ff_sid', sessionId, {
    httpOnly: true,
    maxAge: ONE_YEAR_MS,
    ...opts,
  });
}

/**
 * Clear the session cookie.
 * @param {import('express').Response} res
 * @param {object} [opts]
 */
function clearSessionCookie(res, opts = {}) {
  clearCookie(res, 'ff_sid', opts);
}

/**
 * Non-HttpOnly cookie exposing the member_id for client UX (safe to read in JS).
 * Do NOT trust this value server-side; use ff_sid → DB lookups instead.
 * @param {import('express').Response} res
 * @param {string} memberId
 * @param {object} [opts]
 */
function setMemberCookie(res, memberId, opts = {}) {
  setCookie(res, 'ff_member', memberId, {
    httpOnly: false,
    maxAge: ONE_YEAR_MS,
    ...opts,
  });
}

/**
 * Clear the member convenience cookie.
 * @param {import('express').Response} res
 * @param {object} [opts]
 */
function clearMemberCookie(res, opts = {}) {
  clearCookie(res, 'ff_member', opts);
}

/**
 * Immediately remove espn_s2 from our domain after one-time attestation.
 * @param {import('express').Response} res
 */
function clearEspnS2(res) {
  clearCookie(res, 'espn_s2');
  clearCookie(res, 'ff_espn_s2'); // if you ever stored under this alias
}

/**
 * Optional: clear a handful of app cookies in one go (useful on logout).
 * @param {import('express').Response} res
 */
function clearAllAppCookies(res) {
  ['ff_sid', 'ff_member', 'espn_s2', 'ff_espn_s2', 'ff_auth', 'ff_token', 'ff_login', 'ff_session', 'ff.pre.hex', 'ff.pre.avatar']
    .forEach(name => clearCookie(res, name));
}

module.exports = {
  // primitives
  setCookie,
  clearCookie,
  readCookie,

  // app cookies
  setSessionCookie,
  clearSessionCookie,
  setMemberCookie,
  clearMemberCookie,
  clearEspnS2,
  clearAllAppCookies,
};
