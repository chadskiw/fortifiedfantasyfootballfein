// routes/identity/request-code.js
const express = require('express');
const router = express.Router();

const pool = require('../../src/db/pool'); // adjust path to your pg pool as needed
const notifier = require('../../lib/notifier'); // should expose .send() from notificationapi-node-server-sdk

// ---------- helpers ----------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}
function norm(v) {
  return String(v || '').trim();
}
function memberIdFromCookie(req) {
  const mid = req?.cookies?.ff_member;
  return mid ? String(mid).trim() : null;
}

// ---------- POST /api/identity/request-code ----------
router.post('/request-code', async (req, res) => {
  try {
    const body = req.body || {};
    const raw = norm(body.identifier || body.email || body.phone);
    if (!raw) return res.status(400).json({ ok: false, error: 'missing_identifier' });

    const isEmail = EMAIL_RE.test(raw);
    const phoneE164 = isEmail ? null : toE164(raw);
    const identifier = isEmail ? raw.toLowerCase() : phoneE164;

    if (!identifier) {
      return res.status(422).json({ ok: false, error: 'bad_identifier', message: 'Enter a valid email or E.164 phone.' });
    }

    // Create code + expiry
    const code = genCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const channel = isEmail ? 'email' : 'sms';
    const member_id = memberIdFromCookie(req) || 'ANON';

    // Persist (upsert) code per-identifier
    // Make sure you have this table (see SQL note below).
    await pool.query(
      `
      INSERT INTO ff_identity_code (member_id, identifier, channel, code, attempts, expires_at)
      VALUES ($1, $2, $3, $4, 0, $5)
      ON CONFLICT (identifier) DO UPDATE SET
        member_id  = EXCLUDED.member_id,
        channel    = EXCLUDED.channel,
        code       = EXCLUDED.code,
        attempts   = 0,
        expires_at = EXCLUDED.expires_at
      `,
      [member_id, identifier, channel, code, expiresAt]
    );

    // Optionally stage the unverified contact on quickhitter for convenience
    // (does not mark verified here)
    if (member_id !== 'ANON') {
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, email, phone)
        VALUES ($1, ${isEmail ? '$2' : 'NULL'}, ${!isEmail ? '$2' : 'NULL'})
        ON CONFLICT (member_id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, ff_quickhitter.email),
          phone = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
          updated_at = NOW()
        `,
        [member_id, identifier]
      );
    }

    // ---- Send via NotificationAPI ----
    const type = process.env.NOTIFICATIONAPI_VERIFICATION_ID || 'verification_code';
    if (!notifier || typeof notifier.send !== 'function') {
      console.warn('[request-code] NotificationAPI not initialized; skipping send');
      // Return 202 so UI can show "we’ll notify you when available"
      return res.status(202).json({ ok: false, error: 'delivery_unavailable', reason: 'sdk_not_loaded' });
    }

    // Build "to" correctly for NotificationAPI:
    //  - SMS: { number: '+15551231234' }
    //  - Email: { email: 'you@example.com' }
    const to = isEmail
      ? { id: `email:${identifier}`, email: identifier }
      : { id: `phone:${identifier}`, number: identifier };

    try {
      await notifier.send({
        type,
        to,
        parameters: {
          code,
          expires_min: '10'
        }
      });
    } catch (e) {
      const msg = String(e?.message || e);
      // Map common config issues to a friendly 202
      const reason =
        /No default SMS template/i.test(msg) ? 'sms_not_configured' :
        /email.*not provided/i.test(msg)     ? 'email_missing' :
        /EMAIL.*not provided/i.test(msg)     ? 'email_missing' :
        /email.*not configured/i.test(msg)   ? 'email_not_configured' :
        /All delivery channels are disabled/i.test(msg) ? 'channels_disabled' :
        'send_failed';

      console.warn('[request-code] NotificationAPI send failed:', msg);
      return res.status(202).json({ ok: false, error: 'delivery_unavailable', reason });
    }

    return res.json({ ok: true, channel });
  } catch (e) {
    console.error('[request-code] error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
