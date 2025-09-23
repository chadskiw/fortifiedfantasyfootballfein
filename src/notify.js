// /src/notify.js
// NotificationAPI wrapper for Node/Express (CommonJS). Safe in prod + dev.

let sdk; // memoized

function getSdk() {
  if (sdk !== undefined) return sdk;
  try {
    const mod = require('notificationapi-node-server-sdk');
    sdk = mod?.default || mod;          // handle default/non-default export
  } catch (e) {
    console.error('[notify] load sdk failed:', e?.message || e);
    sdk = null;
    return null;
  }

  const id = process.env.NOTIFICATIONAPI_CLIENT_ID || process.env.NOTIFICATION_API_CLIENT_ID;
  const secret = process.env.NOTIFICATIONAPI_CLIENT_SECRET || process.env.NOTIFICATION_API_CLIENT_SECRET;

  if (!id || !secret) {
    console.warn('[notify] missing NOTIFICATIONAPI_* env; will no-op.');
    return sdk;
  }
  try { sdk.init(id, secret); } catch (e) {
    console.error('[notify] sdk.init failed:', e?.message || e);
  }
  return sdk;
}

function esc(s='') {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Fire a "Teams Update" email.
 * Prefer TEMPLATE_ID from env, but also supports inline overrides if your project allows.
 *
 * Env (server):
 *   NOTIFICATIONAPI_CLIENT_ID
 *   NOTIFICATIONAPI_CLIENT_SECRET
 *   NOTIFICATIONAPI_NOTIFICATION_ID or NOTIFICATIONAPI_TYPE_TEAMS_UPDATE (template id)
 *   NOTIFICATIONAPI_DEFAULT_TO (optional)
 */
async function sendTeamsUpdateEmail({ toEmail, subject, url, html, text } = {}) {
  const api = getSdk();
  if (!api) return false;

  const notificationId =
    process.env.NOTIFICATIONAPI_NOTIFICATION_ID ||
    process.env.NOTIFICATIONAPI_TYPE_TEAMS_UPDATE ||
    'teams_update';

  const emailTo = toEmail || process.env.NOTIFICATIONAPI_DEFAULT_TO || 'fortifiedfantasy@gmail.com';
  const subj = subject || 'Teams Update';
  const bodyText = text || html || url || '';
  const bodyHtml = html || `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${esc(bodyText)}</pre>`;

  // Try classic shape (notificationId + mergeTags)
  try {
    await api.send({
      notificationId,
      user: { id: emailTo, email: emailTo },
      mergeTags: { subject: subj, body: bodyText, url: url || '' },
    });
    return true;
  } catch (e1) {
    // Fallback to override shape (type + email override)
    try {
      await api.send({
        type: notificationId,
        to: { id: emailTo, email: emailTo },
        email: { subject: subj, html: bodyHtml, text: bodyText },
      });
      return true;
    } catch (e2) {
      console.error('[notify] send failed', e1?.message || e1, '→', e2?.message || e2);
      return false;
    }
  }
}

module.exports = { sendTeamsUpdateEmail };
