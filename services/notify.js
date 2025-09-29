// services/notify.js
// Robust notifier shim.
// - Loads dotenv from DOTENV_CONFIG_PATH or ./.env
// - Accepts multiple env name variants
// - Optional debug to log which keys are found (not values)
// - Never throws

const fetch = global.fetch || require('node-fetch');

let warnedNoCreds = false;
let warnedNoTo = false;

function safeLoadDotenv() {
  try {
    const path = process.env.DOTENV_CONFIG_PATH || '.env';
    // eslint-disable-next-line import/no-extraneous-dependencies
    require('dotenv').config({ path, override: false });
  } catch {}
}
safeLoadDotenv();

const DEBUG = String(process.env.NOTIF_DEBUG || '').trim() === '1';

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return { key: k, value: v.trim() };
  }
  return { key: null, value: null };
}

/**
 * Resolve credentials — supports common variants.
 *  Primary:   NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET
 *  Variants:  NOTIFICATION_API_CLIENT_ID / SECRET
 *             NOTIFICATIONAPI_CLIENT_ID / SECRET   (no underscore)
 *             NOTIF_CLIENT_ID / NOTIF_CLIENT_SECRET
 *  Base:      NOTIF_API_BASE or NOTIFICATION_API_BASE (optional)
 */
function getCreds() {
  const id = firstEnv(
    'NOTIF_API_CLIENT_ID',
    'NOTIFICATION_API_CLIENT_ID',
    'NOTIFICATIONAPI_CLIENT_ID',
    'NOTIF_CLIENT_ID'
  );
  const sec = firstEnv(
    'NOTIF_API_CLIENT_SECRET',
    'NOTIFICATION_API_CLIENT_SECRET',
    'NOTIFICATIONAPI_CLIENT_SECRET',
    'NOTIF_CLIENT_SECRET'
  );
  const base = firstEnv('NOTIF_API_BASE', 'NOTIFICATION_API_BASE').value || 'https://api.notificationapi.com';

  if (DEBUG) {
    const cwd = process.cwd();
    const seen = {
      cwd,
      clientId_key: id.key,
      clientSecret_key: sec.key,
      base_key: base ? (process.env.NOTIF_API_BASE ? 'NOTIF_API_BASE' : (process.env.NOTIFICATION_API_BASE ? 'NOTIFICATION_API_BASE' : 'default')) : 'default'
    };
    console.log('NotificationAPI debug:', seen);
  }

  return { clientId: id.value, clientSecret: sec.value, base };
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
      console.warn('NotificationAPI warning. NotificationAPI credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET).');
      warnedNoCreds = true;
    }
    return { ok: false, skipped: true, reason: 'missing_creds' };
  }

  // Best-effort send
  try {
    const r = await fetch(`${base.replace(/\/+$/,'')}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': clientId,
        'x-client-secret': clientSecret
      },
      body: JSON.stringify({
        channel, to, templateId, data
      })
    });

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
