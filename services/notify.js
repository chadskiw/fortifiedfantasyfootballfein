// services/notify.js
// Robust NotificationAPI wrapper with defensive .env loading and aliases.

const path = require('path');

// Load .env defensively (safe if already loaded)
try {
  const envLoaded = require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env') });
  if (envLoaded?.parsed) {
    // noop; only load once
  }
} catch { /* ignore */ }

const NAPI = require('notificationapi-node-server-sdk').default;

// Accept common alias names so dashboards/typos still work
const env = process.env;
const CLIENT_ID =
  env.NOTIF_API_CLIENT_ID ||
  env.NOTIFICATION_API_CLIENT_ID ||
  env.NOTIFICATIONAPI_CLIENT_ID ||
  env.NOTIFICATIONAPI_CLIENTID ||
  env.NOTIF_CLIENT_ID ||
  env.NOTIF_ID ||
  '';

const CLIENT_SECRET =
  env.NOTIF_API_CLIENT_SECRET ||
  env.NOTIFICATION_API_CLIENT_SECRET ||
  env.NOTIFICATIONAPI_CLIENT_SECRET ||
  env.NOTIFICATIONAPI_CLIENTSECRET ||
  env.NOTIF_CLIENT_SECRET ||
  env.NOTIF_SECRET ||
  '';

const SMS_TEMPLATE   = env.NOTIF_SMS_TEMPLATE_ID   || env.NOTIFICATIONAPI_SMS_TEMPLATE_ID   || 'smsDefault';
const EMAIL_TEMPLATE = env.NOTIF_EMAIL_TEMPLATE_ID || env.NOTIFICATIONAPI_EMAIL_TEMPLATE_ID || 'emailDefault';

let inited = false;
let initFailed = false;
let debugPrinted = false;

function mask(v) {
  if (!v) return '(missing)';
  const s = String(v);
  if (s.length <= 6) return '*'.repeat(s.length);
  return s.slice(0, 3) + '…' + s.slice(-3);
}

function debugOnce(msg) {
  if (debugPrinted) return;
  debugPrinted = true;
  console.warn(msg);
}

function ensureInit() {
  if (inited || initFailed) return;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    initFailed = true;
    debugOnce(
      `NotificationAPI credentials missing (id=${mask(CLIENT_ID)}, secret=${mask(CLIENT_SECRET)}).` +
      ` Make sure .env is loaded before requiring services/notify.js`
    );
    return;
  }
  try {
    NAPI.init(CLIENT_ID, CLIENT_SECRET);
    inited = true;
    if (env.NODE_ENV !== 'production') {
      debugOnce(`NotificationAPI initialized (id=${mask(CLIENT_ID)}, secret=${mask(CLIENT_SECRET)})`);
    }
  } catch (e) {
    initFailed = true;
    console.warn('NotificationAPI init error:', e?.message || e);
  }
}

function toE164(input, defaultCountry = '+1') {
  if (!input) return '';
  let s = String(input).trim();
  if (/^\+\d{7,15}$/.test(s)) return s;
  s = s.replace(/\D+/g, '');
  if (!s) return '';
  if (s.length >= 11 && s[0] !== '0') return `+${s}`;
  if (s.length === 10) return `${defaultCountry}${s}`;
  return '';
}

/**
 * sendOne({ channel: 'sms' | 'email', to: string, templateId?: string, data?: object })
 * Returns { ok: boolean, vendor?: any } — never throws outward.
 */
async function sendOne({ channel, to, templateId, data }) {
  ensureInit();

  // If creds weren’t available, don’t crash the flow — just warn once.
  if (!inited) {
    debugOnce('NotificationAPI warning. Credentials not initialized; skipping send.');
    return { ok: false, skipped: true, reason: 'no_creds' };
  }

  const payload = {
    type: 'account_authorization', // your NotificationAPI workflow
    to: {},
    parameters: { ...(data || {}) },
  };

  if (channel === 'sms') {
    const num = toE164(to);
    if (!num) return { ok: false, skipped: true, reason: 'bad_phone' };
    payload.to.number = num;
    if (templateId || SMS_TEMPLATE) payload.templateId = templateId || SMS_TEMPLATE;
  } else if (channel === 'email') {
    const email = String(to || '').trim();
    if (!email) return { ok: false, skipped: true, reason: 'bad_email' };
    payload.to.email = email;
    if (templateId || EMAIL_TEMPLATE) payload.templateId = templateId || EMAIL_TEMPLATE;
  } else {
    return { ok: false, skipped: true, reason: 'bad_channel' };
  }

  try {
    const resp = await NAPI.send(payload);
    return { ok: true, vendor: resp };
  } catch (e) {
    console.warn('NotificationAPI send error:', e?.response?.data || e?.message || e);
    return { ok: false, error: e?.message || 'send_failed' };
  }
}

module.exports = { sendOne, _toE164: toE164, _ensureInit: ensureInit };
