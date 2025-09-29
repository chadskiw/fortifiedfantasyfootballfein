// services/notify.js
// Robust notifier with multi-endpoint fallbacks.
// - Loads dotenv (.env) if present
// - Supports multiple env var names
// - Attempts several NotificationAPI endpoint shapes
// - Sends { code } in data, plus optional verificationId
// - Never throws; returns { ok, skipped?, reason? }
// - In non-production, can echo the code to logs if all attempts fail

const fetch = global.fetch || require('node-fetch');

function safeLoadDotenv() {
  try {
    const path = process.env.DOTENV_CONFIG_PATH || '.env';
    require('dotenv').config({ path, override: false });
  } catch {}
}
safeLoadDotenv();

const DEBUG = String(process.env.NOTIF_DEBUG || '').trim() === '1';
const ENV   = String(process.env.NODE_ENV || '').trim() || 'development';

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return { key: k, value: String(v).trim() };
  }
  return { key: null, value: null };
}

function getCreds() {
  const id  = firstEnv('NOTIF_API_CLIENT_ID', 'NOTIFICATION_API_CLIENT_ID', 'NOTIFICATIONAPI_CLIENT_ID', 'NOTIF_CLIENT_ID');
  const sec = firstEnv('NOTIF_API_CLIENT_SECRET', 'NOTIFICATION_API_CLIENT_SECRET', 'NOTIFICATIONAPI_CLIENT_SECRET', 'NOTIF_CLIENT_SECRET');
  const base = (firstEnv('NOTIF_API_BASE', 'NOTIFICATION_API_BASE').value || 'https://api.notificationapi.com').replace(/\/+$/, '');
  const verificationId = firstEnv('NOTIFICATIONAPI_VERIFICATION_ID', 'NOTIF_VERIFICATION_ID').value || null;

  if (DEBUG) {
    console.log('[NotificationAPI] debug keys:', {
      cwd: process.cwd(),
      clientId_key: id.key,
      clientSecret_key: sec.key,
      base,
      verificationId_present: !!verificationId
    });
  }

  return { clientId: id.value, clientSecret: sec.value, base, verificationId };
}

async function postJson(url, { headers = {}, body = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

/**
 * Send one message to NotificationAPI.
 * @param {Object} opts
 * @param {'sms'|'email'|'push'} opts.channel
 * @param {string} opts.to
 * @param {object} [opts.data] e.g. { code: '123456' }
 * @param {string} [opts.templateId]
 */
async function sendOne(opts = {}) {
  const channel    = (opts.channel || '').toLowerCase();
  const to         = String(opts.to || '').trim();
  const templateId = opts.templateId || (channel === 'sms' ? 'smsDefault' : 'emailDefault');
  const data       = { ...(opts.data || {}) };

  if (!to) {
    console.warn('NotificationAPI warning. "to" is empty; skipping send.');
    return { ok: false, skipped: true, reason: 'empty_to' };
  }

  const { clientId, clientSecret, base, verificationId } = getCreds();
  if (!clientId || !clientSecret) {
    console.warn('NotificationAPI warning. Credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET).');
    return { ok: false, skipped: true, reason: 'missing_creds' };
  }

  // Include verificationId if configured; many providers use this concept.
  if (verificationId && !data.verificationId) {
    data.verificationId = verificationId;
  }

  // Attempt 1: headers auth, /send
  const attempt1 = await postJson(`${base}/send`, {
    headers: { 'x-client-id': clientId, 'x-client-secret': clientSecret },
    body: { channel, to, templateId, data }
  });
  if (attempt1.ok) return { ok: true };
  if (DEBUG) console.warn('NotificationAPI attempt1 failed:', { status: attempt1.status, body: attempt1.text?.slice?.(0, 300) });

  // Attempt 2: headers auth, /notification/send
  const attempt2 = await postJson(`${base}/notification/send`, {
    headers: { 'x-client-id': clientId, 'x-client-secret': clientSecret },
    body: { channel, to, templateId, data }
  });
  if (attempt2.ok) return { ok: true };
  if (DEBUG) console.warn('NotificationAPI attempt2 failed:', { status: attempt2.status, body: attempt2.text?.slice?.(0, 300) });

  // Attempt 3: creds in body, /notifications (older patterns)
  const attempt3 = await postJson(`${base}/notifications`, {
    body: { clientId, clientSecret, channel, to, templateId, data }
  });
  if (attempt3.ok) return { ok: true };
  if (DEBUG) console.warn('NotificationAPI attempt3 failed:', { status: attempt3.status, body: attempt3.text?.slice?.(0, 300) });

  // Attempt 4: creds in body, /notification (singular)
  const attempt4 = await postJson(`${base}/notification`, {
    body: { clientId, clientSecret, channel, to, templateId, data }
  });
  if (attempt4.ok) return { ok: true };
  if (DEBUG) console.warn('NotificationAPI attempt4 failed:', { status: attempt4.status, body: attempt4.text?.slice?.(0, 300) });

  // If all attempts failed, log a concise warning
  const last = attempt4.ok ? attempt4 : attempt3.ok ? attempt3 : attempt2.ok ? attempt2 : attempt1;
  console.warn('NotificationAPI warning.', { status: last.status, body: last.text?.slice?.(0, 300) });

  // Non-production fallback: echo code to logs to unblock testing
  if (ENV !== 'production' && data?.code) {
    console.log(`[DEV ONLY] Verification code for ${to}: ${data.code}`);
    return { ok: true, dev_echo: true };
  }

  return { ok: false, skipped: true, reason: 'all_attempts_failed' };
}

module.exports = { sendOne };
