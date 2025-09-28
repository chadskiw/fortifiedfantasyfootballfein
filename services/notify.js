// services/notify.js
// Robust, once-per-process notifier shim.
// - Detects multiple env var names
// - Loads dotenv (safe even if already loaded)
// - Never throws; logs at most once per issue

const fetch = global.fetch || require('node-fetch');

let warnedNoCreds = false;
let warnedNoTo = false;

function safeLoadDotenv() {
  try {
    // No-op if already loaded
    require('dotenv').config();
  } catch {}
}
safeLoadDotenv();

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Resolve credentials — supports a few common names.
 *  NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET
 *  NOTIFICATION_API_CLIENT_ID / NOTIFICATION_API_CLIENT_SECRET
 *  (optional) NOTIF_API_BASE (defaults to https://api.notificationapi.com)
 */
function getCreds() {
  const clientId = firstEnv(
    'NOTIF_API_CLIENT_ID',
    'NOTIFICATION_API_CLIENT_ID',
    'NOTIF_CLIENT_ID'
  );
  const clientSecret = firstEnv(
    'NOTIF_API_CLIENT_SECRET',
    'NOTIFICATION_API_CLIENT_SECRET',
    'NOTIF_CLIENT_SECRET'
  );
  const base = firstEnv('NOTIF_API_BASE', 'NOTIFICATION_API_BASE') || 'https://api.notificationapi.com';
  return { clientId, clientSecret, base };
}

/**
 * Send one message. Best-effort.
 * @param {Object} opts
 * @param {'email'|'sms'|'push'} opts.channel
 * @param {string} opts.to  email or +E164 phone or device token
 * @param {object} [opts.data]  payload like { code: '123456' }
 * @param {string} [opts.templateId]  ex: 'emailDefault' | 'smsDefault'
 */
async function sendOne(opts = {}) {
  const channel = (opts.channel || '').toLowerCase();
  const to = String(opts.to || '').trim();
  const templateId = opts.templateId || (channel === 'sms' ? 'smsDefault' : 'emailDefault');
  const data = opts.data || {};

  if (!to) {
    if (!warnedNoTo) {
      console.warn('NotificationAPI warning. "to" is empty; skipping send.');
      warnedNoTo = true;
    }
    return { ok: false, skipped: true, reason: 'empty_to' };
  }

  const { clientId, clientSecret, base } = getCreds();
  if (!clientId || !clientSecret) {
    if (!warnedNoCreds) {
      console.warn('NotificationAPI warning. NotificationAPI credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET)');
      warnedNoCreds = true;
    }
    // Don’t fail the caller; verification flow should continue
    return { ok: false, skipped: true, reason: 'missing_creds' };
  }

  // If you have a real NotificationAPI project, wire it here.
  // Below is a safe best-effort POST; failures are swallowed into a non-throwing result.
  try {
    const body = {
      channel,
      to,
      templateId,
      data
    };

    const r = await fetch(`${base.replace(/\/+$/, '')}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': clientId,
        'x-client-secret': clientSecret
      },
      body: JSON.stringify(body)
    });

    // non-2xx → warn once & keep going
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('NotificationAPI warning.', { status: r.status, body: txt?.slice?.(0, 300) || '' });
      return { ok: false, skipped: true, reason: 'http_' + r.status };
    }

    return { ok: true };
  } catch (e) {
    console.warn('NotificationAPI warning.', e?.message || e);
    return { ok: false, skipped: true, reason: 'exception' };
  }
}

module.exports = { sendOne };
