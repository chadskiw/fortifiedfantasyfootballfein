// routes/identity/logout.js
const express = require('express');
const router = express.Router();

/** Compute cookie options that match how they were set */
function cookieBaseOpts(req) {
  // secure if behind TLS or proxy says https
  const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const secure = req.secure || xfProto === 'https';

  // derive a sensible domain (so we can also clear on subdomains)
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = host.split(':')[0]; // strip port
  let domain; // undefined means "don’t set Domain=…, clear only for this exact host"

  // prefer clearing across *.fortifiedfantasy.com
  if (hostname.endsWith('fortifiedfantasy.com')) {
    domain = '.fortifiedfantasy.com';
  } else if (hostname.includes('.') && hostname !== 'localhost') {
    // fallback: attempt broad domain for other envs (dev/stage)
    domain = '.' + hostname.split('.').slice(-2).join('.');
  }

  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    domain, // may be undefined
  };
}

/** Clear a cookie with multiple variants (path/domain) */
function clearCookieEverywhere(res, name, base) {
  // variant 1: explicit base (includes domain when available)
  res.clearCookie(name, base);

  // variant 2: without domain (some cookies may have been set w/o Domain)
  const noDomain = { ...base };
  delete noDomain.domain;
  res.clearCookie(name, noDomain);
}

/** Known cookie names we use around FF + ESPN proxy */
const COOKIE_NAMES = [
  // FF auth/session
  'ff_member', 'ff_member_id', 'ff_logged_in',
  // ESPN-related (if you ever proxied them)
  's2', 'SWID', 'swid', 's2_hash',
  // generic session ids
  'sid', 'session', 'connect.sid',
];

router.post('/logout', (req, res) => {
  try {
    // Belt + suspenders: tell modern browsers to clear cookies & storage
    // (Only effective in secure contexts; harmless otherwise.)
    res.set('Clear-Site-Data', '"cookies", "storage"');

    const base = cookieBaseOpts(req);

    // Clear our known cookies with/without Domain
    COOKIE_NAMES.forEach((name) => clearCookieEverywhere(res, name, base));

    // Kill any server session
    try {
      if (req.session && typeof req.session.destroy === 'function') {
        req.session.destroy(() => {});
      }
    } catch {}

    // No content needed
    return res.status(204).end();
  } catch (e) {
    console.error('[identity.logout]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Optional convenience: GET -> POST
router.get('/logout', (req, res) => router.handle(req, res));

module.exports = router;
