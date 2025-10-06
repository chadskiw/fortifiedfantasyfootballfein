// routes/espn-login.js
// Minimal ESPN login-bounce: accepts swid & s2 in query, sets cookies, redirects.
// Example:
//   GET /api/espn/login?swid={1149...}&s2=ABC...&to=/fein/index.html?season=2025

const express = require('express');
const router  = express.Router();

// --- helpers ---
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Lax',
  secure  : true,
  path    : '/',               // visible to whole site
  // domain: '.fortifiedfantasy.com', // uncomment if you need subdomains
};

// ESPN uses braced SWID. Normalize anything we get to "{UUID}" uppercase.
function normalizeSwid(raw) {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(String(raw));
    const m = decoded.match(/\{?([0-9a-fA-F-]{36})\}?/);
    if (!m) return null;
    return `{${m[1].toUpperCase()}}`;
  } catch {
    return null;
  }
}

function toAbsolute(url, req) {
  try {
    // allow absolute URLs (https://fortifiedfantasy.com/fein/...), otherwise build from host
    return new URL(url, `${req.protocol}://${req.get('host')}`).toString();
  } catch {
    return `${req.protocol}://${req.get('host')}/fein/?season=${new Date().getUTCFullYear()}`;
  }
}

// ===================================================================
// GET /api/espn/login?swid={...}&s2=...&to=/fein/index.html?season=2025
// - Sets SWID (HttpOnly) and espn_s2 (HttpOnly) cookies on our domain.
// - Redirects to ?to=… (defaults to /fein?season=<year>).
// ===================================================================
router.get('/login', (req, res) => {
  try {
    const swidBrace = normalizeSwid(req.query.swid);
    const s2        = req.query.s2 && String(req.query.s2).trim();
    const toParam   = req.query.to && String(req.query.to).trim();
    const fallback  = `/fein/?season=${new Date().getUTCFullYear()}`;
    const redirectTo = toAbsolute(toParam || fallback, req);

    // Require at least SWID; S2 is optional (some flows don’t include it).
    if (!swidBrace) {
      return res.status(400).json({ ok: false, error: 'bad_swid' });
    }

    // Set cookies for our domain. Names match your app’s expectations.
    // Note: Firefox shows SWID as percent-encoded in devtools; that’s normal for HttpOnly.
    res.cookie('SWID', encodeURIComponent(swidBrace), COOKIE_OPTS);
    if (s2) res.cookie('espn_s2', s2, COOKIE_OPTS);

    // Optional: you can prime your own session here if you want
    // (e.g., res.cookie('ff_sid', makeSid(), COOKIE_OPTS))

    // Redirect back to FEIN (or caller-supplied URL)
    return res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn.login]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
