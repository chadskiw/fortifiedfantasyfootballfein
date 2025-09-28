// routes/identity/request-code.js
const express = require('express');
const router = express.Router();
router.use(express.json());

const pool = require('../../src/db/pool'); // adjust as needed

// --- NotificationAPI SDK init (cached) ---
let notificationapi;
function napi() {
  if (notificationapi) return notificationapi;
  const mod = require('notificationapi-node-server-sdk');
  notificationapi = mod?.default || mod;
  const id  = process.env.NOTIFICATIONAPI_CLIENT_ID;
  const sec = process.env.NOTIFICATIONAPI_CLIENT_SECRET;
  notificationapi.init(id, sec);
  return notificationapi;
}

// --- helpers ---
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function toE164(raw) {
  const d = String(raw || '').replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}
const norm = v => String(v || '').trim();
const genCode = () => String(Math.floor(100000 + Math.random()*900000));
const addMin  = (ms, m) => new Date(ms + m*60000);

function memberId(req){
  const mid = req?.cookies?.ff_member;
  return mid ? String(mid).trim() : null;
}

// ============ POST /api/identity/request-code ============
router.post('/request-code', async (req, res) => {
  try {
    const identifierRaw = norm(req.body?.identifier || req.body?.phone || req.body?.email);
    if (!identifierRaw) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const isEmail = EMAIL_RE.test(identifierRaw);
    const phoneE164 = isEmail ? null : toE164(identifierRaw);
    const identifier = isEmail ? identifierRaw.toLowerCase() : phoneE164;

    if (!identifier) {
      return res.status(422).json({ ok:false, error:'bad_identifier', message:'Enter a valid email or E.164 phone.' });
    }

    // build NotificationAPI "to" properly
    const to = isEmail
      ? { id: `email:${identifier}`, email: identifier }
      : { id: `phone:${identifier}`, number: identifier };

    // stage code in DB
    const code = genCode();
    const expiresAt = addMin(Date.now(), 10);
    const channel = isEmail ? 'email' : 'sms';
    const mid = memberId(req) || 'ANON';

    await pool.query(`
      INSERT INTO ff_identity_code (member_id, identifier, channel, code, attempts, expires_at)
      VALUES ($1, $2, $3, $4, 0, $5)
      ON CONFLICT (identifier) DO UPDATE SET
        member_id  = EXCLUDED.member_id,
        channel    = EXCLUDED.channel,
        code       = EXCLUDED.code,
        attempts   = 0,
        expires_at = EXCLUDED.expires_at
    `, [mid, identifier, channel, code, expiresAt]);

    // (optional) stage the contact on quickhitter without marking verified
    if (mid !== 'ANON') {
      await pool.query(`
        INSERT INTO ff_quickhitter (member_id, email, phone)
        VALUES ($1, ${isEmail ? '$2' : 'NULL'}, ${!isEmail ? '$2' : 'NULL'})
        ON CONFLICT (member_id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, ff_quickhitter.email),
          phone = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
          updated_at = now()
      `, [mid, identifier]);
    }

    // send via NotificationAPI
    const type = process.env.NOTIFICATIONAPI_VERIFICATION_ID || 'verification_code';
    try {
      await napi().send({
        type,
        to,                       // <-- THIS is the critical fix
        parameters: {
          code,
          expires_min: '10'
        }
      });
    } catch (e) {
      const msg = String(e?.message || e);
      // Map common “discarded” reasons to a friendly 202 so UI shows the fallback
      const reason =
        /No default SMS template/i.test(msg)                ? 'sms_not_configured' :
        /EMAIL.*not provided/i.test(msg)                    ? 'email_missing' :
        /email.*not configured/i.test(msg)                  ? 'email_not_configured' :
        /user.*number.*not provided|phone.*not provided/i.test(msg) ? 'phone_missing' :
        /All delivery channels are disabled|discarded/i.test(msg)   ? 'channels_disabled' :
        'send_failed';

      console.warn('[identity.request-code] NotificationAPI warning:', msg);
      return res.status(202).json({ ok:false, error:'delivery_unavailable', reason });
    }

    return res.json({ ok:true, channel });
  } catch (e) {
    console.error('[identity.request-code] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
