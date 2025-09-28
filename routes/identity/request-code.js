// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const notify  = require('../../services/notify'); // exports sendOne({channel,to,templateId?,data?})

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // already valid phone/email?
  if (E164_RX.test(s)) return { kind: 'phone', value: s, channel: 'sms' };
  if (EMAIL_RX.test(s.toLowerCase())) return { kind: 'email', value: s.toLowerCase(), channel: 'email' };

  // coerce phone-like strings to E.164 (default +1)
  const digits = s.replace(/\D+/g, '');
  if (digits.length >= 10 && digits.length <= 15) {
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (E164_RX.test(e164)) return { kind: 'phone', value: e164, channel: 'sms' };
  }

  return null;
}

function genCode() {
  // uniform 6-digit
  if (crypto.randomInt) return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post('/request-code', async (req, res) => {
  try {
    const norm = normalizeIdentifier(req.body?.identifier);
    if (!norm) return res.status(400).json({ ok:false, error:'invalid_identifier' });

    const { kind: identifier_kind, value: identifier_value, channel } = norm;

    // optional: associate with the current user if you have one (TEXT FK)
    const member_id =
      (req.user && String(req.user.id)) ||
      (req.body && req.body.member_id) ||
      null;

    const code    = genCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // purge truly stale rows for this identifier/channel
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

      // ✅ INSERT with correct 6 placeholders
      await client.query(
        `INSERT INTO ff_identity_code
           (member_id, identifier_kind, identifier_value, channel, code, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [member_id, identifier_kind, identifier_value, channel, code, expires] // JS Date is fine for pg
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[identity/request-code] db error:', e);
      return res.status(500).json({ ok:false, error:'db_error' });
    } finally {
      client.release();
    }

    // fire-and-forget notify (don’t fail the request if vendor hiccups)
    try {
      await notify.sendOne({
        channel,              // 'email' | 'sms'
        to: identifier_value, // email or E.164
        data: { code }        // available as {{code}} in your template
      });
    } catch (err) {
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
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
