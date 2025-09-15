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

// GET: from bookmarklet (?swid=&s2=&to=)
router.get('/', (req, res) => {
  let { swid, s2, to } = req.query || {};
  if (!swid || !s2) {
    return res.status(400).json({ ok: false, error: 'missing swid/s2' });
  }

  // Normalize SWID braces/case — but DO NOT touch s2
  swid = normalizeSwid(swid);

  // Wipe any prior variants (just in case)
  res.clearCookie('SWID',     { ...baseCookieOpts });
  res.clearCookie('espn_s2',  { ...baseCookieOpts });
  res.clearCookie('fein_has_espn', { path: '/' });

  // Set fresh cookies
  res.cookie('SWID',     swid, { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('espn_s2',  s2,   { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('fein_has_espn', '1', { path: '/', maxAge: MAX_AGE });  // readable flag

  // Safe redirect (back to the exact FF page if provided)
  const target = safeTarget(to);
  return res.redirect(303, target);
});

// POST: from “Paste SWID & S2” fallback (JSON body)
router.post('/', express.json(), (req, res) => {
  let { swid, s2, to } = req.body || {};
  if (!swid || !s2) {
    return res.status(400).json({ ok: false, error: 'missing swid/s2' });
  }
  swid = normalizeSwid(swid);

  res.clearCookie('SWID',     { ...baseCookieOpts });
  res.clearCookie('espn_s2',  { ...baseCookieOpts });
  res.clearCookie('fein_has_espn', { path: '/' });

  res.cookie('SWID',     swid, { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('espn_s2',  s2,   { ...baseCookieOpts, httpOnly: true,  maxAge: MAX_AGE });
  res.cookie('fein_has_espn', '1', { path: '/', maxAge: MAX_AGE });

  // For POST we return JSON (frontend can decide where to go next),
  // but you can also 303 to safeTarget(to) if you prefer.
  return res.status(200).json({ ok: true, to: safeTarget(to) });
});

// DELETE: logout
router.delete('/', (req, res) => {
  res.clearCookie('SWID',     { ...baseCookieOpts });
  res.clearCookie('espn_s2',  { ...baseCookieOpts });
  res.clearCookie('fein_has_espn', { path: '/' });
  res.json({ ok: true, cleared: true });
});

module.exports = router;
