// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const notify  = require('../../services/notify'); // your existing notifier wrapper

const router = express.Router();
router.use(express.json());

// helpers
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

const isEmail = v => EMAIL_RX.test(String(v||'').trim().toLowerCase());
const toE164  = raw => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g,'');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
};

function genCode() {
  // 6-digit, uniform distribution
  return String(100000 + (crypto.randomInt ? crypto.randomInt(900000) : Math.floor(Math.random()*900000)));
}

router.post('/request-code', async (req, res) => {
  try {
// inside POST /api/identity/request-code
const raw = String(req.body?.identifier || '').trim();
if (!raw) return res.status(400).json({ ok:false, error:'missing_identifier' });

const isPhone = /^\+[1-9]\d{7,14}$/.test(raw); // E.164
const identifier_kind  = isPhone ? 'phone' : 'email';
const identifier_value = raw.toLowerCase(); // normalize emails
const channel          = isPhone ? 'sms' : 'email';

// Optional member (text FK). If you have a session user, provide it; otherwise null.
const member_id = (req.user && String(req.user.id)) || null;

// 6-digit random
const code = String(Math.floor(100000 + Math.random() * 900000)).padStart(6, '0');
// 10-minute expiry
const expires = new Date(Date.now() + 10 * 60 * 1000);

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // house-keeping: purge old expired rows for this identifier/channel
  await client.query(
    `DELETE FROM ff_identity_code
      WHERE identifier_kind=$1 AND identifier_value=$2 AND channel=$3
        AND (expires_at < now() OR consumed_at IS NOT NULL)`,
    [identifier_kind, identifier_value, channel]
  );

  // ensure only one active: consume any lingering unconsumed one
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
    [member_id, identifier_kind, identifier_value, channel, code, expires.toISOString()]
  );

  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('[identity/request-code] db error:', e);
  return res.status(500).json({ ok:false, error:'db_error' });
} finally {
  client.release();
}

// === send via NotificationAPI (your existing notify.js) ===
// Map to template and delivery options by channel.
try {
  await notify.sendOne({
    channel,               // 'email' or 'sms'
    to: identifier_value,  // email address or E.164 phone
    templateId: channel === 'sms' ? (process.env.NOTIF_SMS_TEMPLATE || 'smsDefault')
                                  : (process.env.NOTIF_EMAIL_TEMPLATE || 'emailDefault'),
    data: { code },        // so your template can render the 6-digit code
  });
} catch (err) {
  // You can still return 200 even if delivery vendor warns;
  // the code is stored and can be re-sent.
  console.warn('NotificationAPI warning.', err?.messages || err?.message || err);
}

return res.json({ ok:true, channel, sent:true, expires_at: expires.toISOString() });

  } catch (err) {
    console.error('[identity/request-code] error:', err);
    if (String(err.message || '').includes('NotificationAPI creds missing')) {
      return res.status(500).json({ ok:false, error:'notify_not_configured' });
    }
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
