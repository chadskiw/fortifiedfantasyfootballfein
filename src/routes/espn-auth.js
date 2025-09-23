// TRUE_LOCATION: src/routes/espn-auth.js
// IN_USE: FALSE
// server/routes/espn-auth.js
const express = require('express');
const router = express.Router();

/**
 * Fortified Fantasy — ESPN Auth Cookie Setter (Express)
 * - Accepts GET/POST with swid, s2, (optional) to
 * - Sets HttpOnly cookies for SWID & espn_s2 on the fortifedfantasy.com domain
 * - Sets a readable flag cookie `fein_has_espn=1`
 * - Safely redirects back to `to` if it’s on fortifiedfantasy.com, else default
 *
 * Notes:
 * - DO NOT decode or re-encode cookie values; store exactly what you receive.
 * - Bookmarklet may double-encode plus/equals, yielding `%2B`/`%3D`; that’s fine.
 */

const DOMAIN   = '.fortifiedfantasy.com';                 // apex + subdomains
const MAX_AGE  = 300 * 24 * 60 * 60 * 1000;               // ~300d in ms
const DEFAULT_RETURN = 'https://fortifiedfantasy.com/fein/index.html?season=2025';

// one place for cookie options
const baseCookieOpts = {
  path: '/',
  domain: DOMAIN,
  secure: true,
  sameSite: 'lax',
};

function normalizeSwid(swidRaw) {
  if (!swidRaw) return swidRaw;
  const trimmed = String(swidRaw).trim();
  // Ensure {GUID} with braces and uppercase
  if (/^\{[0-9a-f-]{36}\}$/i.test(trimmed)) return trimmed.toUpperCase();
  const core = trimmed.replace(/^\{|\}$/g, '').toUpperCase();
  return `{${core}}`;
}

// Only allow redirects back onto fortifiedfantasy.com
function safeTarget(to) {
  try {
    const u = new URL(to);
    if (u.hostname.endsWith('fortifiedfantasy.com')) return u.toString();
  } catch {}
  return DEFAULT_RETURN;
}

/**
 * Helper: read cookies safely even if cookie-parser isn't installed.
 */
function getCookieMap(req) {
  if (req.cookies) return req.cookies; // if cookie-parser is in use
  const raw = req.headers.cookie || '';
  const map = {};
  raw.split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    map[k] = v;
  });
  return map;
}
const url = new URL(request.url);
// don't await — let the redirect proceed immediately
waitUntil(fetch(`${url.origin}/api/_notify/teams-update`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: url.toString(), subject: 'Teams Update' }),
}).catch(() => {}));

/**
 * NEW: status check (GET with no swid/s2) — lets the client confirm auth
 * and stamps the readable helper cookie if SWID & espn_s2 are present.
 */
router.get('/', (req, res, next) => {
  // if bookmarklet params are present, fall through to your existing handler
  const { swid, s2 } = req.query || {};
  if (swid && s2) return next(); // continue to the existing GET handler below

  const cookies = getCookieMap(req);
  const hasSWID = !!cookies.SWID;
  const hasS2   = !!(cookies.espn_s2 || cookies.ESPN_S2);

  // if both are there, ensure the frontend-readable helper is stamped
  if (hasSWID && hasS2) {
    res.cookie('fein_has_espn', '1', { ...baseCookieOpts, httpOnly: false, maxAge: MAX_AGE });
  }

  return res.status(200).json({ ok: true, linked: hasSWID && hasS2, hasSWID, hasS2 });
});


/**
 * EXISTING: GET from bookmarklet (?swid=&s2=&to=) — keep as is
 */
router.get('/', (req, res) => {
  let { swid, s2, to } = req.query || {};
  if (!swid || !s2) {
    return res.status(400).json({ ok: false, error: 'missing swid/s2' });
  }

  swid = normalizeSwid(swid);

  res.clearCookie('SWID',            { ...baseCookieOpts });
  res.clearCookie('espn_s2',         { ...baseCookieOpts });
  res.clearCookie('fein_has_espn',   { path: '/' });

  res.cookie('SWID',    swid, { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('espn_s2', s2,   { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('fein_has_espn', '1',   { ...baseCookieOpts, httpOnly: false, maxAge: MAX_AGE });

  const target = safeTarget(to);
  return res.redirect(303, target);
});

/**
 * EXISTING: POST fallback — keep as is
 */
router.post('/', express.json(), (req, res) => {
  let { swid, s2, to } = req.body || {};
  if (!swid || !s2) {
    return res.status(400).json({ ok: false, error: 'missing swid/s2' });
  }
  swid = normalizeSwid(swid);

  res.clearCookie('SWID',            { ...baseCookieOpts });
  res.clearCookie('espn_s2',         { ...baseCookieOpts });
  res.clearCookie('fein_has_espn',   { path: '/' });

  res.cookie('SWID',    swid, { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('espn_s2', s2,   { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('fein_has_espn', '1',   { ...baseCookieOpts, httpOnly: false, maxAge: MAX_AGE });

  return res.status(200).json({ ok: true, to: safeTarget(to) });
});

/**
 * EXISTING: DELETE (logout) — keep as is
 */
router.delete('/', (req, res) => {
  res.clearCookie('SWID',            { ...baseCookieOpts });
  res.clearCookie('espn_s2',         { ...baseCookieOpts });
  res.clearCookie('fein_has_espn',   { path: '/' });
  res.json({ ok: true, cleared: true });
});

module.exports = router;