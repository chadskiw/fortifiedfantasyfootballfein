// routes/verify.js
const express = require('express');
const router = express.Router();
const { pool } = require('../../server');
const crypto = require('crypto');
const { buildCodeFromCookie, buildSeededCode } = require('../util/anagram');


const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;
const norm = (v='') => String(v).trim();
const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex');
}
// --- Optional NotificationAPI (won't crash if not installed) ---
let notificationapi = null;
try {
  notificationapi = require('notificationapi-node-server-sdk').default;
  notificationapi.init(
    process.env.NOTIFICATIONAPI_CLIENT_ID || '',
    process.env.NOTIFICATIONAPI_CLIENT_SECRET || ''
  );
} catch (e) {
  console.warn('[notify] SDK not available; skipping:', e?.message || e);
}

/** POST /api/verify
 * body: { email? , phone? , code }
 * If code matches derived(ff_sess): upsert member.
 * Else: issue a new seeded code (no edits to email/phone) and return 401 with retry:true.
 */
router.post('/verify', async (req, res) => {
  try {
    const ffSess = req.cookies?.ff_sess;
    if (!ffSess) return res.status(400).json({ ok:false, error:'no_session' });

    // IMPORTANT: identifiers are not editable here; we accept only those sent now and use same on retry
    const rawEmail = norm(req.body?.email || '');
    const rawPhone = norm(req.body?.phone || '');
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? normEmail(rawEmail) : null;
    const phone = !email && rawPhone && PHONE_RE.test(rawPhone) ? normPhone(rawPhone) : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const userCode = norm(req.body?.code || '').toUpperCase();
    if (!userCode) return res.status(400).json({ ok:false, error:'missing_code' });

    const expected = buildCodeFromCookie(ffSess);

    if (userCode === expected) {
      // ✅ success → upsert ff_member
      const ua = String(req.get('user-agent') || '').slice(0, 512);
      const ip = hashIP(req.headers['cf-connecting-ip'] || req.ip || '');

      const q = await pool.query(`
        INSERT INTO ff_member (
          email, phone_e164, email_verified_at, phone_verified_at,
          first_seen_at, last_seen_at, user_agent, ip_hash
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, $6)
        ON CONFLICT (email) DO UPDATE SET
          last_seen_at = NOW(),
          email_verified_at = COALESCE(ff_member.email_verified_at, $3),
          phone_verified_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE ff_member.phone_verified_at END,
          user_agent = $5,
          ip_hash = $6
        RETURNING member_id, username, email, phone_e164, email_verified_at, phone_verified_at
      `, [
        email || null,
        phone || null,
        email ? new Date().toISOString() : null,
        phone ? new Date().toISOString() : null,
        ua,
        ip
      ]);

      const member = q.rows[0];

      // Link any invite rows for this identifier
      try {
        await pool.query(
          `UPDATE ff_invite
              SET joined_at = NOW(), member_id = $1
            WHERE first_identifier = $2 AND joined_at IS NULL`,
          [member.member_id, email || phone]
        );
      } catch (e) {
        console.warn('[verify] invite link skipped:', e.code || e.message);
      }

      return res.json({ ok:true, member });
    }

    // ❌ mismatch → derive new code from (ff_sess + timestamp) and (mock) send to SAME identifier
    const retryCode = buildSeededCode(ffSess, Date.now());
    console.log(`[Mock Retry] To: ${email || phone} — New code: ${retryCode}`);

    // Optionally record a new invite attempt
    try {
      await pool.query(
        `INSERT INTO ff_invite (interacted_code, member_id, invited_at, source, medium, user_agent, ip_hash, first_identifier)
         VALUES ($1, NULL, NOW(), $2, $3, $4, $5, $6)`,
        [
          retryCode,
          'verify-retry',
          email ? 'email' : 'sms',
          String(req.get('user-agent') || '').slice(0, 512),
          hashIP(req.headers['cf-connecting-ip'] || req.ip || ''),
          email || phone
        ]
      );
    } catch (e) {
      console.warn('[verify] retry invite insert skipped:', e.code || e.message);
    }

    return res.status(401).json({ ok:false, error:'invalid_code', retry:true });
  } catch (e) {
    console.error('[verify]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
