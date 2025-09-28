// src/services/notify.js
// NotificationAPI wrapper for Verification (email + SMS) and other transactional sends.

let sdk;

function getSdk() {
  if (sdk !== undefined) return sdk;
  try {
    const mod = require('notificationapi-node-server-sdk');
    sdk = mod?.default || mod; // handle default/non-default export
  } catch (e) {
    console.error('[notify] sdk load failed:', e?.message || e);
    sdk = null;
    return null;
  }

  const id = process.env.NOTIFICATIONAPI_CLIENT_ID || process.env.NOTIFICATION_API_CLIENT_ID;
  const secret = process.env.NOTIFICATIONAPI_CLIENT_SECRET || process.env.NOTIFICATION_API_CLIENT_SECRET;

  if (!id || !secret) {
    console.warn('[notify] missing NOTIFICATIONAPI_* credentials; sends will be no-op.');
    return sdk; // allow callers to see no-op state
  }
  try { sdk.init(id, secret); } catch (e) {
    console.error('[notify] sdk.init failed:', e?.message || e);
  }
  return sdk;
}

// ---------- helpers ----------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/; // ITU E.164

function ensureE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}

// ---------- sends ----------
/**
 * Send a verification code using NotificationAPI.
 * Requires a Notification configured in your NotificationAPI project with:
 *   - ID in env: NOTIFICATIONAPI_VERIFICATION_ID  (fallback 'verification_code')
 *   - Email and/or SMS channels enabled.
 * We pass user:{ id, email?, phone? } and mergeTags:{ code, expires_min }.
 *
 * Returns: { ok:true, channel:'email'|'sms' } or { ok:false, reason:'...' }
 */
async function sendVerification({ identifier, code, expiresMin = 10 }) {
  const api = getSdk();
  if (!api) return { ok:false, reason:'sdk_not_loaded' };

  const notifId =
    process.env.NOTIFICATIONAPI_VERIFICATION_ID ||
    process.env.NOTIFICATIONAPI_TYPE_VERIFICATION ||
    'verification_code';

  const isEmail = EMAIL_RE.test(String(identifier||'').trim());
  const phoneE164 = ensureE164(identifier);

  // Build the user object correctly so NotificationAPI routes to the right channel
  const user = isEmail
    ? { id: identifier.toLowerCase(), email: identifier.toLowerCase() }
    : (phoneE164 ? { id: phoneE164, phone: phoneE164 } : null);

  if (!user) return { ok:false, reason:'bad_identifier' };

  // Try the standard shape (notificationId + mergeTags + user)
  try {
    await api.send({
      notificationId: notifId,
      user,
      mergeTags: {
        code: String(code),
        expires_min: String(expiresMin)
      }
    });

    return { ok:true, channel: isEmail ? 'email' : 'sms' };
  } catch (e) {
    // Common reasons: no templates/channels configured for this notification,
    // or project missing default channel templates.
    const msg = String(e?.message || e);
    // Provide a compact reason so the API route can map to UX copy.
    if (/email/i.test(msg) && /not configured|no default/i.test(msg)) {
      return { ok:false, reason:'email_not_configured', detail: msg };
    }
    if (/sms|phone|twilio/i.test(msg) && /not configured|no default/i.test(msg)) {
      return { ok:false, reason:'sms_not_configured', detail: msg };
    }
    return { ok:false, reason:'send_failed', detail: msg };
  }
}

module.exports = {
  getSdk,
  sendVerification,
  ensureE164,
  EMAIL_RE,
  E164_RE
};
