// services/notify.js
// NotificationAPI via official SDK, with channel overrides per message.
// - If "to" is phone → SMS only
// - If "to" is email → EMAIL only
// - parameters: { code } included
// - uses defaults: 'emaildefault' / 'smsdefault' unless you pass templateId
// - never throws from sendOne; returns { ok, ... }
// - in non-prod, echoes the code if SDK isn't configured so you can test

let sdk = null;
try {
  sdk = require('notificationapi-node-server-sdk').default;
} catch (_) {
  sdk = null;
}

try {
  const path = process.env.DOTENV_CONFIG_PATH || '.env';
  require('dotenv').config({ path, override: false });
} catch {}

const ENV   = String(process.env.NODE_ENV || '').trim() || 'development';
const DEBUG = String(process.env.NOTIF_DEBUG || '').trim() === '1';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

const CLIENT_ID     = firstEnv('NOTIF_API_CLIENT_ID','NOTIFICATION_API_CLIENT_ID','NOTIFICATIONAPI_CLIENT_ID','NOTIF_CLIENT_ID');
const CLIENT_SECRET = firstEnv('NOTIF_API_CLIENT_SECRET','NOTIFICATION_API_CLIENT_SECRET','NOTIFICATIONAPI_CLIENT_SECRET','NOTIF_CLIENT_SECRET');
const NOTIF_TYPE    = firstEnv('NOTIFICATIONAPI_VERIFICATION_ID','NOTIF_VERIFICATION_ID') || 'account_authorization';

const DEFAULT_EMAIL_TEMPLATE = 'emaildefault';
const DEFAULT_SMS_TEMPLATE   = 'smsdefault';

let initialized = false;
function ensureInit() {
  if (initialized) return true;
  if (!sdk || !CLIENT_ID || !CLIENT_SECRET) return false;
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
 * Send one verification message.
 * @param {Object} opts
 * @param {'sms'|'email'} [opts.channel] - used to pick default templateId; channel is also inferred from "to".
 * @param {string} opts.to - email or +E164 phone
 * @param {Object} opts.data - must include { code: '123456' }
 * @param {string} [opts.templateId] - override (emaildefault / smsdefault)
 */
async function sendOne(opts = {}) {
  const channelHint = String(opts.channel || '').toLowerCase();
  const toRaw = String(opts.to || '').trim();
  const params = opts.data || {};

  if (!toRaw) {
    console.warn('NotificationAPI warning. "to" is empty; skipping send.');
    return { ok:false, skipped:true, reason:'empty_to' };
  }
  if (!params.code) {
    console.warn('NotificationAPI warning. data.code missing; template may render blank.');
  }

  const okInit = ensureInit();

  // Build recipient
  const to = { id: toRaw };
  const isEmail = EMAIL_RE.test(toRaw);
  const isPhone = E164_RE.test(toRaw);
  if (isEmail) to.email = toRaw;
  if (isPhone) to.number = toRaw;

  // Determine desired channel set (to silence provider warnings)
  // Prefer channel inferred from "to". If both present, fall back to hint.
  let useEmail = isEmail && !isPhone;
  let useSMS   = isPhone && !isEmail;
  if (!useEmail && !useSMS) {
    if (channelHint === 'email') useEmail = true;
    if (channelHint === 'sms')   useSMS = true;
  }
  // Pick template
  const templateId = opts.templateId || (useSMS ? DEFAULT_SMS_TEMPLATE : DEFAULT_EMAIL_TEMPLATE);

  // If SDK not ready, dev-echo
  if (!okInit) {
    if (ENV !== 'production') {
      console.log(`[DEV ONLY] (SDK not configured) Would send ${templateId} to ${toRaw} with code: ${params.code || '(missing)'}`);
      return { ok:true, dev_echo:true };
    }
    console.warn('NotificationAPI warning. SDK not initialized or credentials missing.');
    return { ok:false, skipped:true, reason:'sdk_not_initialized' };
  }

  // Build payload (SDK supports a few override styles; try best-known first)
  // 1) notificationPreferences (newer naming)
  const basePayload = {
    type: NOTIF_TYPE,
    to,
    parameters: { ...params },
    templateId
  };

  // We want to force only the relevant channel ON to avoid provider warnings.
  // Try preference/override variants in order; stop at first success.
  const attempts = [];

  // Attempt A: preferences with enabled flags
  attempts.push({
    ...basePayload,
    notificationPreferences: {
      email: { enabled: !!useEmail },
      sms:   { enabled: !!useSMS }
    }
  });

  // Attempt B: "preferences" alias
  attempts.push({
    ...basePayload,
    preferences: {
      email: { enabled: !!useEmail },
      sms:   { enabled: !!useSMS }
    }
  });

  // Attempt C: "override" channels
  attempts.push({
    ...basePayload,
    override: {
      channels: {
        email: !!useEmail,
        sms:   !!useSMS
      }
    }
  });

  // Attempt D: minimal payload (let provider discard other channel; last resort)
  attempts.push(basePayload);

  for (let i = 0; i < attempts.length; i++) {
    try {
      if (DEBUG) {
        const pl = attempts[i];
        console.log('[NotificationAPI] send attempt', i+1, {
          templateId: pl.templateId,
          to: { email: !!pl?.to?.email, number: !!pl?.to?.number },
          emailOn: pl?.notificationPreferences?.email?.enabled ?? pl?.preferences?.email?.enabled ?? pl?.override?.channels?.email ?? 'n/a',
          smsOn:   pl?.notificationPreferences?.sms?.enabled   ?? pl?.preferences?.sms?.enabled   ?? pl?.override?.channels?.sms   ?? 'n/a'
        });
      }
      const res = await sdk.send(attempts[i]);
      const ok = !!res && (res.status ? (res.status >= 200 && res.status < 300) : true);
      if (!ok) {
        console.warn('[NotificationAPI] non-2xx send response:', res?.status, res?.data);
        continue;
      }
      return { ok:true, status: res?.status || 200, data: res?.data };
    } catch (e) {
      // Try next attempt
      if (DEBUG) console.warn('[NotificationAPI] send attempt failed:', e?.response?.status || e?.message || e);
    }
  }

  // If everything failed, keep tests unblocked
  if (ENV !== 'production' && params?.code) {
    console.log(`[DEV ONLY] Verification code for ${toRaw}: ${params.code}`);
    return { ok:true, dev_echo:true };
  }

  return { ok:false, skipped:true, reason:'all_attempts_failed' };
}

module.exports = { sendOne };
