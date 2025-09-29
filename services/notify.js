// services/notify.js
// NotificationAPI via official SDK.
// - init() from env once
// - sendOne({ channel, to, data:{ code }, templateId? }) → { ok, ... }
// - never throws; safe for API routes
// - echoes code in non-production if SDK isn't configured so you can test

let sdk = null;
try {
  // ESM default export; for CJS require we need .default
  // eslint-disable-next-line import/no-extraneous-dependencies
  sdk = require('notificationapi-node-server-sdk').default;
} catch (_) {
  sdk = null;
}

// Optional dotenv (local dev)
try {
  const path = process.env.DOTENV_CONFIG_PATH || '.env';
  require('dotenv').config({ path, override: false });
} catch {}

const ENV = String(process.env.NODE_ENV || '').trim() || 'development';
const DEBUG = String(process.env.NOTIF_DEBUG || '').trim() === '1';

// simple validators
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// Read creds (with aliases you used earlier)
const CLIENT_ID = firstEnv(
  'NOTIF_API_CLIENT_ID',
  'NOTIFICATION_API_CLIENT_ID',
  'NOTIFICATIONAPI_CLIENT_ID',
  'NOTIF_CLIENT_ID'
);
const CLIENT_SECRET = firstEnv(
  'NOTIF_API_CLIENT_SECRET',
  'NOTIFICATION_API_CLIENT_SECRET',
  'NOTIFICATIONAPI_CLIENT_SECRET',
  'NOTIF_CLIENT_SECRET'
);

// Notification type (aka workflow) — your example uses this
// Default to 'account_authorization' which matches your env & example
const NOTIF_TYPE = firstEnv('NOTIFICATIONAPI_VERIFICATION_ID', 'NOTIF_VERIFICATION_ID') || 'account_authorization';

// Default templates (you can override via sendOne({ templateId }))
const DEFAULT_EMAIL_TEMPLATE = 'emaildefault';
const DEFAULT_SMS_TEMPLATE   = 'smsdefault';

// Initialize SDK once if available & creds present
let initialized = false;
function ensureInit() {
  if (initialized) return true;
  if (!sdk) return false;
  if (!CLIENT_ID || !CLIENT_SECRET) return false;
  try {
    sdk.init(CLIENT_ID, CLIENT_SECRET);
    initialized = true;
    if (DEBUG) console.log('[NotificationAPI] SDK initialized');
    return true;
  } catch (e) {
    console.warn('[NotificationAPI] init failed:', e?.message || e);
    return false;
  }
}

/**
 * Send one verification notification.
 * @param {Object} opts
 * @param {'sms'|'email'|'push'} [opts.channel] - used only to choose a default templateId
 * @param {string} opts.to - email or +E164 number
 * @param {Object} opts.data - must include { code: '123456' }
 * @param {string} [opts.templateId] - override template id (emaildefault / smsdefault)
 */
async function sendOne(opts = {}) {
  const channel = String(opts.channel || '').toLowerCase();
  const toRaw   = String(opts.to || '').trim();
  const data    = opts.data || {};

  if (!toRaw) {
    console.warn('NotificationAPI warning. "to" is empty; skipping send.');
    return { ok: false, skipped: true, reason: 'empty_to' };
  }
  if (!data.code) {
    console.warn('NotificationAPI warning. data.code missing; template may render blank.');
  }

  const okInit = ensureInit();

  // Build "to" block per SDK example
  const to = { id: toRaw };
  if (EMAIL_RE.test(toRaw)) to.email = toRaw;
  if (E164_RE.test(toRaw))  to.number = toRaw;

  const templateId = opts.templateId || (channel === 'sms' ? DEFAULT_SMS_TEMPLATE : DEFAULT_EMAIL_TEMPLATE);

  // If SDK not ready, keep dev unblocked
  if (!okInit) {
    if (ENV !== 'production') {
      console.log(`[DEV ONLY] (SDK not configured) Would send ${templateId} to ${toRaw} with code: ${data.code || '(missing)'}`);
      return { ok: true, dev_echo: true };
    }
    console.warn('NotificationAPI warning. SDK not initialized or credentials missing.');
    return { ok: false, skipped: true, reason: 'sdk_not_initialized' };
  }

  // Real send
  try {
    const payload = {
      type: NOTIF_TYPE,   // e.g., 'account_authorization'
      to,
      parameters: { ...data }, // { code: '123456', ... }
      templateId
    };
    if (DEBUG) console.log('[NotificationAPI] send payload:', { ...payload, parameters: { ...payload.parameters, code: '******' } });

    const res = await sdk.send(payload); // returns axios-like response
    // Some SDKs return { data }, others might be void—normalize:
    const ok = !!res && (res.status ? (res.status >= 200 && res.status < 300) : true);
    if (!ok) console.warn('[NotificationAPI] non-2xx send response:', res?.status, res?.data);
    return { ok: true, status: res?.status || 200, data: res?.data };
  } catch (e) {
    console.warn('NotificationAPI warning.', e?.response?.status, e?.response?.data || e?.message || e);
    if (ENV !== 'production' && data?.code) {
      console.log(`[DEV ONLY] Verification code for ${toRaw}: ${data.code}`);
      return { ok: true, dev_echo: true };
    }
    return { ok: false, skipped: true, reason: 'exception' };
  }
}

module.exports = { sendOne };
