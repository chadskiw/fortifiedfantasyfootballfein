// services/notify.js — minimal NotificationAPI wrapper (channel-safe)
const notificationapi = require('notificationapi-node-server-sdk').default;

const {
  NOTIF_API_CLIENT_ID,
  NOTIF_API_CLIENT_SECRET,
  NOTIF_SMS_TEMPLATE_ID   = 'smsDefault',
  NOTIF_EMAIL_TEMPLATE_ID = 'emailDefault',
} = process.env;

let _inited = false;
function ensureInit() {
  if (_inited) return;
  if (!NOTIF_API_CLIENT_ID || !NOTIF_API_CLIENT_SECRET) {
    throw new Error('NotificationAPI credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET)');
  }
  notificationapi.init(NOTIF_API_CLIENT_ID, NOTIF_API_CLIENT_SECRET);
  _inited = true;
}

function toE164(input, defaultCountry = '+1') {
  if (!input) return '';
  let s = String(input).trim();
  if (/^\+\d{7,15}$/.test(s)) return s;
  s = s.replace(/\D+/g, '');
  if (!s) return '';
  if (s.length >= 11 && s[0] !== '0') return `+${s}`;
  return `${defaultCountry}${s}`;
}

/**
 * sendOne({ channel:'sms'|'email', to:string, templateId?, data? })
 */
async function sendOne({ channel, to, templateId, data }) {
  ensureInit();

  const payload = {
    type: 'account_authorization',
    to: {},
    parameters: { ...(data || {}) },
  };

  if (channel === 'sms') {
    const e164 = toE164(to);
    if (!e164) throw new Error('sendOne: invalid phone number for sms');
    payload.to.number = e164;
    payload.templateId = (templateId || NOTIF_SMS_TEMPLATE_ID || '').trim() || undefined;
  } else if (channel === 'email') {
    const email = String(to || '').trim();
    if (!email) throw new Error('sendOne: missing email for email channel');
    payload.to.email = email;
    payload.templateId = (templateId || NOTIF_EMAIL_TEMPLATE_ID || '').trim() || undefined;
  } else {
    throw new Error('sendOne: unsupported channel');
  }

  if (!payload.templateId) delete payload.templateId; // avoid vendor warnings
  return notificationapi.send(payload);
}

module.exports = { sendOne, _toE164: toE164 };
