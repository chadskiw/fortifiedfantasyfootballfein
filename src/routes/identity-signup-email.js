// TRUE_LOCATION: src/routes/identity-signup-email.js
// IN_USE: FALSE
// routes/identity-signup-email.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool'); // direct, no circular dep
const crypto = require('crypto');
const { buildCodeFromCookie } = require('../src/anagram');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;
const norm = (v='') => String(v).trim();
const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex');
}

/** POST /api/identity/signup-email
 * body: { email? , phone? }
 * Derives a code from ff_sess and (mock) “sends” it. Also inserts a minimal ff_invite row.
 */
router.post('/signup-email', async (req, res) => {
  try {
    const ffSess = req.cookies?.ff_sess;
    if (!ffSess) return res.status(400).json({ ok:false, error:'no_session' });

    const rawEmail = norm(req.body?.email || '');
    const rawPhone = norm(req.body?.phone || '');
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? normEmail(rawEmail) : null;
    const phone = !email && rawPhone && PHONE_RE.test(rawPhone) ? normPhone(rawPhone) : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const code = buildCodeFromCookie(ffSess);
    // Mock “send”
    console.log(`[Mock Send] To: ${email || phone} — Code: ${code}`);

    // Record invite (best effort; table columns per your schema)
    try {
      await pool.query(
        `INSERT INTO ff_invite (
           interacted_code, member_id, invited_at, source, medium, landing_url, referrer, user_agent, ip_hash, first_identifier
         ) VALUES ($1, NULL, NOW(), $2, $3, $4, $5, $6, $7, $8)`,
        [
          code,                                // storing the code itself (since it’s deterministic & mock)
          'signup',                            // source
          email ? 'email' : 'sms',             // medium
          String(req.headers['x-landing-url'] || ''),  // optional passthroughs
          String(req.get('referer') || ''),
          String(req.get('user-agent') || '').slice(0, 512),
          hashIP(req.headers['cf-connecting-ip'] || req.ip || ''),
          email || phone
        ]
      );
    } catch (e) {
      console.warn('[signup-email] invite insert skipped:', e.code || e.message);
    }

    return res.json({ ok:true, sent:true });
  } catch (e) {
    console.error('[signup-email]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
