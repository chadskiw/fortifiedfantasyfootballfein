// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const notify  = require('../../services/notify'); // exports { sendOne }

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

// Normalize any email/phone-ish input → { kind:'email'|'phone', value, channel:'email'|'sms' }
function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (E164_RX.test(s)) return { kind: 'phone', value: s, channel: 'sms' };
  if (EMAIL_RX.test(s.toLowerCase())) return { kind: 'email', value: s.toLowerCase(), channel: 'email' };

  // Try to coerce a phone
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
    if (!norm) return res.status(400).json({ ok:false, error:'invalid_identifier' });

    const { kind: identifier_kind, value: identifier_value, channel } = norm;

    const member_id =
      (req.user && String(req.user.id)) ||
      (req.body && req.body.member_id) ||
      null;

    // 10-minute window
    const ttlMs   = 10 * 60 * 1000;
    const now     = Date.now();
    const expires = new Date(now + ttlMs);

    let codeToSend = null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Look for an active, unconsumed code for this identifier/channel
      const existing = await client.query(
        `
          SELECT id, code
            FROM ff_identity_code
           WHERE identifier_kind = $1
             AND identifier_value = $2
             AND channel = $3
             AND consumed_at IS NULL
             AND expires_at > NOW()
           ORDER BY created_at DESC
           LIMIT 1
        `,
        [identifier_kind, identifier_value, channel]
      );

      if (existing.rows.length) {
        // 2a) Reuse the same code; optionally "refresh" the expiry window
        const row = existing.rows[0];
        codeToSend = row.code;

        // Bump expiry so the user always has ~10 minutes from (re)request
        await client.query(
          `UPDATE ff_identity_code
              SET expires_at = $2
            WHERE id = $1`,
          [row.id, expires]
        );
      } else {
        // 2b) No active code → insert a new one
        codeToSend = genCode();
        await client.query(
          `
            INSERT INTO ff_identity_code
              (member_id, identifier_kind, identifier_value, channel, code, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6)
          `,
          [member_id, identifier_kind, identifier_value, channel, codeToSend, expires]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[identity/request-code] db error:', e);
      return res.status(500).json({ ok:false, error:'db_error' });
    } finally {
      client.release();
    }

    // 3) Notify (best-effort; warning logs only if it fails/misconfigured)
    try {
      await notify.sendOne({
        channel,              // 'email' | 'sms'
        to: identifier_value, // email or +E164
        data: { code: codeToSend }
      });
    } catch (err) {
      console.warn('NotificationAPI warning.', err?.messages || err?.message || err);
    }

    return res.json({
      ok: true,
      channel,
      sent: true,
      expires_at: expires.toISOString()
      // (intentionally not returning the code)
    });
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
