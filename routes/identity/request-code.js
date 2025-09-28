// routes/identity/request-code.js
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');
const notify  = require('../../notify'); // your existing notifier wrapper

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
    const raw = String(req.body?.identifier || '').trim();
    if (!raw) return res.status(400).json({ ok:false, error:'missing_identifier' });

    let kind, value;
    if (isEmail(raw)) {
      kind = 'email';
      value = raw.toLowerCase();
    } else {
      const e164 = toE164(raw);
      if (!e164 || !E164_RX.test(e164)) {
        return res.status(422).json({ ok:false, error:'invalid_identifier' });
      }
      kind = 'phone';
      value = e164;
    }

    // who is making the request (optional)
    const memberId =
      (req.user && req.user.id) ||
      req.body?.member_id ||
      req.query?.member_id ||
      null;

    const code = genCode();
    const ttlMinutes = 10;

    // store → ff_identity_code
    // schema expectation:
    // (id bigserial, identifier_kind text, identifier_value text, member_id uuid null,
    //  code text, expires_at timestamptz, consumed_at timestamptz null, created_at timestamptz default now())
    await pool.query(
  `UPDATE ff_identity_code
     SET consumed_at = NOW()
   WHERE identifier_kind = $1 AND identifier_value = $2 AND consumed_at IS NULL`,
  [kind, value]
);

    await pool.query(
      `
      INSERT INTO ff_identity_code
        (identifier_kind, identifier_value, member_id, code, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)
      `,
      [kind, value, memberId, code, String(ttlMinutes)]
    );

    // optional: clean up old/expired
    pool.query(`DELETE FROM ff_identity_code WHERE expires_at < NOW() - interval '1 day'`).catch(()=>{});

    // deliver via your NotificationAPI wrapper
    const templateId = kind === 'email' ? 'emailDefault' : 'smsDefault';
    const payload = { code }; // used in your template
    await notify.send({
      kind,            // 'email' | 'phone'
      to: value,       // email or E.164 phone
      templateId,      // maps inside notify.js
      payload,
    });

    return res.json({ ok:true, kind, to:value, ttlMinutes });
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    if (String(err.message || '').includes('NotificationAPI creds missing')) {
      return res.status(500).json({ ok:false, error:'notify_not_configured' });
    }
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
