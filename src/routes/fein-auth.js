// /routes/fein-auth.js
const express = require('express');
const router  = express.Router();
const { sendTeamsUpdateEmail } = require('../src/notify');

// Normalize SWID to ESPN’s {UUID} shape
function normalizeSwid(raw = '') {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.startsWith('{') ? v.toUpperCase() : `{${v.replace(/[{}]/g,'').toUpperCase()}}`;
}

function absoluteUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host  = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}

// GET /api/espn-auth?swid={...}&s2=...&to=https%3A%2F%2Ffortifiedfantasy.com%2Ffein%2Findex.html%3Fseason%3D2025
router.get('/', async (req, res) => {
  try {
    const swid = normalizeSwid(req.query.swid || req.query.SWID || '');
    const s2   = String(req.query.s2 || req.query.espn_s2 || '').trim();

    // Compose redirect target (default to /fein)
    const toRaw = String(req.query.to || '').trim();
    let redirectTo = '/fein';
    try {
      if (toRaw) {
        // Only allow same-origin absolute URLs or any-path relative URL
        const u = new URL(toRaw, `${req.protocol}://${req.get('host')}`);
        redirectTo = u.href;
      }
    } catch {
      // If parsing fails, we’ll keep default
    }

    // Always set cookies if we have creds
    if (swid && s2) {
      // Non-HTTPOnly so your front-end can read if needed
      res.cookie('SWID', swid, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
      });
      res.cookie('espn_s2', s2, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
      });

      // Your app has code paths that also look for these:
      res.cookie('ff_espn_swid', swid, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
      });
      res.cookie('ff_espn_s2', s2, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
      });
    }

    // --- NEW: email on every hit ---
    const fullUrl = absoluteUrl(req);
    const html = `
      <div style="font:14px/1.45 system-ui,Segoe UI,Roboto,Arial,sans-serif">
        <p>ESPN Auth endpoint was hit.</p>
        <p><strong>URL:</strong></p>
        <pre style="white-space:break-spaces;background:#f6f8fa;padding:8px;border-radius:6px;border:1px solid #eee">${fullUrl}</pre>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      </div>
    `.trim();

    // Fire and forget; don’t block redirect on failure
    sendTeamsUpdateEmail({
      toEmail: process.env.NOTIFICATIONAPI_DEFAULT_TO || 'fortifiedfantasy@gmail.com',
      subject: 'Teams Update',
      html,
    }).catch((e) => console.error('[espn-auth] email error:', e));

    // Continue original behavior: redirect the user
    res.redirect(302, redirectTo);
  } catch (e) {
    console.error('[espn-auth]', e);
    // Fallback: still redirect to /fein so UX doesn’t get stuck
    res.redirect(302, '/fein');
  }
});

module.exports = router;
