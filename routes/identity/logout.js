// routes/identity/logout.js
const express = require('express');
const router = express.Router();

/** Compute cookie options that match how they were set */
function cookieBaseOpts(req) {
  const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const secure = req.secure || xfProto === 'https';

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = host.split(':')[0];
  let domain;
  if (hostname.endsWith('fortifiedfantasy.com')) domain = 'fortifiedfantasy.com';
  else if (hostname.includes('.') && hostname !== 'localhost') domain = '.' + hostname.split('.').slice(-2).join('.');

  return { path: '/', httpOnly: true, sameSite: 'Lax', secure, domain };
}

/** Clear a cookie with multiple variants (matches both with and without Domain=) */
function clearCookieEverywhere(res, name, base) {
  res.clearCookie(name, base);              // with domain (if any)
  const noDomain = { ...base };             // <-- was a typo before
  delete noDomain.domain;
  res.clearCookie(name, noDomain);          // without domain
}

/** Add every cookie we actually set */
const COOKIE_NAMES = [
  // FF auth/session
  'ff_member', 'ff_member_id', 'ff_session_id', 'ff_logged_in',
  // ESPN / misc
  's2', 'SWID', 'swid', 's2_hash',
  // generic session ids
  'sid', 'session', 'connect.sid',
];

function doLogout(req, res) {
  try {
    // ask browser to wipe cookies + storage for this origin
    res.set('Clear-Site-Data', '"cookies", "storage"');

    const base = cookieBaseOpts(req);
    COOKIE_NAMES.forEach((name) => clearCookieEverywhere(res, name, base));

    if (req.session && typeof req.session.destroy === 'function') {
      try { req.session.destroy(() => {}); } catch {}
    }
    return res.status(204).end();
  } catch (e) {
    console.error('[identity.logout]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

router.post('/logout', doLogout);
// Fix the recursion: call the same handler for GET as well
router.get('/logout', doLogout);

module.exports = router;
