// routes/verify.js
const express = require('express');
const router = express.Router();
const { pool } = require('../../server');
const { buildCodeFromCookie } = require('../src/anagram');
const crypto = require('crypto');

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex');
}

router.post('/verify', async (req, res) => {
  try {
    const ffSess = req.cookies?.ff_sess;
    const email  = String(req.body?.email || '').trim().toLowerCase();
    const phone  = String(req.body?.phone || '').trim();
    const code   = String(req.body?.code || '').trim().toUpperCase();
    const ua     = req.get('user-agent') || '';
    const ip     = req.headers['cf-connecting-ip'] || req.ip || '';

    if (!ffSess) return res.status(400).json({ ok:false, error:'no_session' });
    if (!email && !phone) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const expected = buildCodeFromCookie(ffSess);

    if (code === expected) {
      // Upsert member
      const q = await pool.query(`
        INSERT INTO ff_member (email, phone_e164, email_verified_at, phone_verified_at,
                               first_seen_at, last_seen_at, user_agent, ip_hash)
        VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, $6)
        ON CONFLICT (email) DO UPDATE
          SET last_seen_at = NOW(),
              email_verified_at = COALESCE(ff_member.email_verified_at, $3),
              phone_verified_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE ff_member.phone_verified_at END,
              user_agent = $5,
              ip_hash = $6
        RETURNING member_id, email, phone_e164, email_verified_at, phone_verified_at
      `, [
        email || null,
        phone || null,
        email ? new Date().toISOString() : null,
        phone ? new Date().toISOString() : null,
        ua,
        hashIP(ip)
      ]);

      const member = q.rows[0];

      // Mark invite joined (if any)
      await pool.query(
        `UPDATE ff_invite
            SET joined_at = NOW(), member_id = $1
          WHERE first_identifier = $2 AND joined_at IS NULL`,
        [member.member_id, email || phone]
      );

      // TODO: set cookies ff_sess/ff_csrf if not already
      return res.json({ ok:true, member });
    }

    // On mismatch → issue new seeded code (based on cookie + timestamp)
    const retryCode = buildCodeFromCookie(ffSess + Date.now());
    console.log(`[Mock Retry] To: ${email || phone} — New code: ${retryCode}`);

    res.status(401).json({ ok:false, error:'invalid_code', retry:true });
  } catch (e) {
    console.error('verify error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
