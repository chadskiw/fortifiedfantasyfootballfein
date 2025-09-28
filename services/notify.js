// services/notify.js
let notificationapi;
function sdk() {
  if (notificationapi) return notificationapi;
  const mod = require('notificationapi-node-server-sdk');
  notificationapi = mod?.default || mod;
  const id  = process.env.NOTIFICATIONAPI_CLIENT_ID;
  const sec = process.env.NOTIFICATIONAPI_CLIENT_SECRET;
  notificationapi.init(id, sec);
  return notificationapi;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function toE164(raw){
  const d = String(raw||'').replace(/\D+/g,'');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}

/**
 * Sends a verification code via NotificationAPI.
 * Expects a Notification with this ID to have SMS (and/or Email) channel configured.
 */
async function sendVerification({ identifier, code, expiresMin = 10 }) {
  const api = sdk();
  const type = process.env.NOTIFICATIONAPI_VERIFICATION_ID || 'verification_code';

  const isEmail = EMAIL_RE.test(String(identifier||'').trim());
  const phone   = toE164(identifier);

  const to = isEmail
    ? { id: `email:${identifier.toLowerCase()}`, email: identifier.toLowerCase() }
    : (phone ? { id: `phone:${phone}`, number: phone } : null);

  if (!to) return { ok:false, reason:'bad_identifier' };

  try {
    await api.send({
      type,            // <-- Notification ID in your dashboard
      to,              // <-- for SMS must be { number: '+16175551212' }
      parameters: {    // <-- template vars (Handlebars)
        code: String(code),
        expires_min: String(expiresMin)
      }
    });
    return { ok:true, channel: isEmail ? 'email' : 'sms' };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/No default SMS template/i.test(msg))  return { ok:false, reason:'sms_not_configured', detail: msg };
    if (/user.*email.*not provided/i.test(msg)) return { ok:false, reason:'email_missing', detail: msg };
    if (/EMAIL.*not provided/i.test(msg))      return { ok:false, reason:'email_missing', detail: msg };
    if (/email.*not configured/i.test(msg))    return { ok:false, reason:'email_not_configured', detail: msg };
    return { ok:false, reason:'send_failed', detail: msg };
  }
}

module.exports = { sendVerification, toE164, EMAIL_RE };
