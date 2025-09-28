// routes/identity/request-code.js
const express = require('express');
const router  = express.Router();

const NotificationAPI = require('notificationapi-node-server-sdk').default;

// --- ENV ---------------------------------------------------------------------
const {
  NOTIF_API_CLIENT_ID,
  NOTIF_API_CLIENT_SECRET,
  NOTIF_SMS_TEMPLATE_ID   = 'smsDefault',    // <- rename if your SMS template id differs
  NOTIF_EMAIL_TEMPLATE_ID = 'emailDefault',  // <- rename if your Email template id differs
} = process.env;

let _inited = false;
function ensureNotifInit() {
  if (_inited) return;
  if (!NOTIF_API_CLIENT_ID || !NOTIF_API_CLIENT_SECRET) {
    throw new Error('NotificationAPI creds missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET)');
  }
  NotificationAPI.init(NOTIF_API_CLIENT_ID, NOTIF_API_CLIENT_SECRET);
  _inited = true;
}

// Very light E.164 for US; adapt if you support more regions broadly
function toE164(input, defaultCountry = '+1') {
  if (!input) return '';
  let s = String(input).trim();
  if (/^\+\d{7,15}$/.test(s)) return s;
  s = s.replace(/\D+/g, '');
  if (!s) return '';
  // If already includes CC (11+ digits), just prefix +
  if (s.length >= 11) return `+${s}`;
  // Assume US
  return `${defaultCountry}${s}`;
}

// Generate a 6-digit code (000000–999999)
function genCode() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

// Optional: plug in your own storage (session/DB/redis) here:
async function savePendingCode({ memberId, destination, code }) {
  // no-op placeholder — your existing flow likely already persists;
  // keep it hooked up to whatever you had.
  return true;
}

// --- ROUTE -------------------------------------------------------------------
/**
 * POST /api/identity/request-code
 * Body can include: { email?, phone?, identifier? }
 *  - If both email & phone are present → send to BOTH (separate sends).
 *  - If only one present → send only that channel.
 */
router.post('/request-code', async (req, res) => {
  try {
    ensureNotifInit();

    // Accept either explicit fields or a single identifier
    const emailRaw = (req.body?.email || '').trim();
    const phoneRaw = (req.body?.phone || '').trim();
    const ident    = (req.body?.identifier || '').trim();

    let email = emailRaw;
    let phone = phoneRaw;

    // If identifier looks like email/phone, map it
    if (!email && /\S+@\S+\.\S+/.test(ident)) email = ident;
    if (!phone && /[0-9()+\-\s.]/.test(ident) && !/\S+@\S+\.\S+/.test(ident)) phone = ident;

    // At least one channel must be provided
    if (!email && !phone) {
      return res.status(400).json({ ok:false, error:'missing_destination', hint:'Provide email and/or phone' });
    }

    const code  = genCode();
    const tasks = [];

    // persist the code using your mechanism (optional placeholder)
    try { await savePendingCode({ memberId: req.user?.id, destination: email || phone, code }); } catch {}

    // --- SEND: SMS (only include number to avoid EMAIL warnings)
    if (phone) {
      const number = toE164(phone);
      if (!number) {
        return res.status(400).json({ ok:false, error:'invalid_phone' });
      }
      tasks.push(
        NotificationAPI.send({
          type: 'account_authorization',
          to:   { number },
          parameters: { code },
          templateId: NOTIF_SMS_TEMPLATE_ID, // force SMS template
        }).then(
          (r) => ({ channel:'sms', ok:true,  id:r?.id || null }),
          (e) => ({ channel:'sms', ok:false, err:String(e && e.message || e) })
        )
      );
    }

    // --- SEND: Email (only include email to avoid SMS warnings)
    if (email) {
      tasks.push(
        NotificationAPI.send({
          type: 'account_authorization',
          to:   { email },
          parameters: { code },
          templateId: NOTIF_EMAIL_TEMPLATE_ID, // force Email template
        }).then(
          (r) => ({ channel:'email', ok:true,  id:r?.id || null }),
          (e) => ({ channel:'email', ok:false, err:String(e && e.message || e) })
        )
      );
    }

    const results = await Promise.all(tasks);

    // If at least one channel succeeded, treat as ok; include per-channel status
    const anyOk = results.some(r => r.ok);
    if (!anyOk) {
      return res.status(502).json({ ok:false, error:'deliveries_failed', results });
    }

    return res.json({ ok:true, results });
  } catch (e) {
    console.error('[identity/request-code] error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
