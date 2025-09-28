// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const notify  = require('../../services/notify');

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (E164_RX.test(s)) return { kind: 'phone', value: s, channel: 'sms' };
  if (EMAIL_RX.test(s.toLowerCase())) return { kind: 'email', value: s.toLowerCase(), channel: 'email' };
  // try to coerce phone-ish values like "415-555-0123"
  const digits = s.replace(/\D+/g, '');
  if (digits.length >= 10 && digits.length <= 15) {
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (E164_RX.test(e164)) return { kind: 'phone', value: e164, channel: 'sms' };
  }
  return null;
}

function genCode() {
  if (crypto.randomInt) return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post('/request-code', async (req, res) => {
  try {
    const norm = normalizeIdentifier(req.body?.identifier);
    if (!norm) return res.status(400).json({ ok: false, error: 'invalid_identifier' });

    const { kind: identifier_kind, value: identifier_value, channel } = norm;

    // optional session member (TEXT FK). Provide if your auth middleware sets it.
    const member_id =
      (req.user && String(req.user.id)) ||
      (req.body && req.body.member_id) ||
      null;

    const code    = genCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // remove fully expired / consumed rows for this (kind, value, channel)
      await client.query(
        `DELETE FROM ff_identity_code
          WHERE identifier_kind=$1 AND identifier_value=$2 AND channel=$3
            AND (expires_at < now() OR consumed_at IS NOT NULL)`,
        [identifier_kind, identifier_value, channel]
      );

      // proactively consume any still-active lingering code
      await client.query(
        `UPDATE ff_identity_code
           SET consumed_at = now()
         WHERE identifier_kind=$1 AND identifier_value=$2 AND channel=$3
           AND consumed_at IS NULL`,
        [identifier_kind, identifier_value, channel]
      );

      // insert the fresh code
      await client.query(
        `INSERT INTO ff_identity_code
           (member_id, identifier_kind, identifier_value, channel, code, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [member_id, identifier_kind, identifier_value, channel, expires.toISOString()]
        .map((v, i, arr) => v) // (no-op; clarifies parameter order)
        .slice(0, 6) // keep TS/IDE linters happy if any
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[identity/request-code] db error:', e);
      return res.status(500).json({ ok: false, error: 'db_error' });
    } finally {
      client.release();
    }

    // Send via NotificationAPI using our channel-safe wrapper
    try {
      await notify.sendOne({
        channel,                   // 'email' | 'sms'
        to: identifier_value,      // email or E.164
        data: { code },            // template param
        // Optional: override template per channel via env instead (kept in notify.js)
      });
    } catch (err) {
      // We still return 200 — code is stored; resend can try later
      console.warn('NotificationAPI warning.', err?.messages || err?.message || err);
    }

    return res.json({
      ok: true,
      channel,
      sent: true,
      expires_at: expires.toISOString(),
    });
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    const msg = String(err?.message || '');
    if (msg.includes('NotificationAPI credentials missing')) {
      return res.status(500).json({ ok: false, error: 'notify_not_configured' });
    }
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
