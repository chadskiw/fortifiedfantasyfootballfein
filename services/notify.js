// services/notify.js
const fetch = require('node-fetch');

let _ready = false;
let _base, _clientId, _clientSecret;

function ensureInit() {
  if (_ready) return;
  _base         = process.env.NOTIF_API_BASE || 'https://api.notificationapi.com';
  _clientId     = process.env.NOTIF_API_CLIENT_ID || '';
  _clientSecret = process.env.NOTIF_API_CLIENT_SECRET || '';
  _ready = true;
}

async function sendOne({ channel, to, templateId, data }) {
  ensureInit();

  if (!_clientId || !_clientSecret) {
    const msg = 'NotificationAPI credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET)';
    console.warn('NotificationAPI warning.', msg);
    return { ok:false, warning: msg };
  }

  const payload = {
    user: {
      // the vendor wants either email or number depending on channel
      email: channel === 'email' ? to : undefined,
      number: channel === 'sms'   ? to : undefined
    },
    channels: [channel.toUpperCase()], // ['EMAIL'] or ['SMS']
    templateId: templateId || (channel === 'sms' ? 'smsDefault' : 'emailDefault'),
    data: data || {}
  };

  const r = await fetch(`${_base}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-notificationapi-client-id': _clientId,
      'x-notificationapi-client-secret': _clientSecret
    },
    body: JSON.stringify(payload)
  });

  // do not throw on non-200 — we just surface messages for logging
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    console.warn('NotificationAPI warning.', j || (await r.text().catch(()=>r.statusText)));
  }
  return { ok: r.ok, response: j };
}

module.exports = { sendOne };
