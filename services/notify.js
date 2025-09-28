// notify.js — NotificationAPI wrapper (SMS-first, no channel warnings)

const notificationapi = require('notificationapi-node-server-sdk').default;

// ---- ENV ----
// Set these in your environment (.env or hosting panel)
const {
  NOTIF_API_CLIENT_ID,
  NOTIF_API_CLIENT_SECRET,
  NOTIF_SMS_TEMPLATE_ID = 'smsDefault', // change if your template id is different
} = process.env;

// guard init once
let _inited = false;
function ensureInit() {
  if (_inited) return;
  if (!NOTIF_API_CLIENT_ID || !NOTIF_API_CLIENT_SECRET) {
    throw new Error('NotificationAPI credentials missing (NOTIF_API_CLIENT_ID / NOTIF_API_CLIENT_SECRET)');
  }
  notificationapi.init(NOTIF_API_CLIENT_ID, NOTIF_API_CLIENT_SECRET);
  _inited = true;
}

// basic E.164 normalizer (assumes US if no +country; adjust as needed)
function toE164(input, defaultCountry = '+1') {
  if (!input) return '';
  let s = String(input).trim();
  // already E.164
  if (/^\+\d{7,15}$/.test(s)) return s;
  // strip non-digits
  s = s.replace(/\D+/g, '');
  // if it already begins with country code length ~11 for US, heuristic
  if (s.length >= 11 && s[0] !== '0') return '+' + s;
  return defaultCountry + s;
}

/**
 * Send account authorization code via SMS.
 * - Requires an SMS template with a {{code}} parameter.
 * - Defaults to templateId from NOTIF_SMS_TEMPLATE_ID (e.g., "smsDefault").
 *
 * @param {Object} params
 * @param {string} params.number  Phone number (any format; we normalize)
 * @param {string} params.code    Verification code (string)
 * @param {string} [params.templateId] Optional template override
 * @returns {Promise<Object>} NotificationAPI response
 */
async function sendAuthCodeSMS({ number, code, templateId }) {
  ensureInit();

  const e164 = toE164(number);
  if (!e164) {
    throw new Error('sendAuthCodeSMS: missing/invalid phone number');
  }
  if (!code) {
    throw new Error('sendAuthCodeSMS: missing code');
  }

  const payload = {
    type: 'account_authorization',
    to: { number: e164 },             // SMS only → avoids EMAIL/PUSH warnings
    parameters: { code: String(code) }
  };

  // Force template if provided or fallback to default id
  const tid = (templateId || NOTIF_SMS_TEMPLATE_ID || '').trim();
  if (tid) payload.templateId = tid;

  return notificationapi.send(payload);
}

/**
 * Send account authorization via BOTH channels (if provided).
 * - Pass email to send email; pass number to send SMS.
 * - Avoids warnings by only including fields you actually have.
 *
 * @param {Object} params
 * @param {string} [params.email]  Recipient email
 * @param {string} [params.number] Phone number (any format)
 * @param {string} params.code     Verification code
 * @param {string} [params.smsTemplateId] Optional SMS template id
 * @param {string} [params.emailTemplateId] Optional Email template id
 */
async function sendAuthCodeMulti({ email, number, code, smsTemplateId, emailTemplateId }) {
  ensureInit();
  if (!email && !number) throw new Error('sendAuthCodeMulti: provide email and/or number');
  if (!code) throw new Error('sendAuthCodeMulti: missing code');

  const to = {};
  if (email) to.email = String(email).trim();
  if (number) to.number = toE164(number);

  const payload = {
    type: 'account_authorization',
    to,
    parameters: { code: String(code) }
  };

  // Channel-specific template selection:
  // NotificationAPI supports one templateId overall; if you need per-channel
  // templates, create separate notification types or dispatch two sends.
  // Here we prioritize SMS template when only SMS present; otherwise prefer email template.
  if (to.number && !to.email && smsTemplateId) {
    payload.templateId = smsTemplateId;
  } else if (to.email && !to.number && emailTemplateId) {
    payload.templateId = emailTemplateId;
  } else if (to.number && !to.email && NOTIF_SMS_TEMPLATE_ID) {
    payload.templateId = NOTIF_SMS_TEMPLATE_ID;
  }

  return notificationapi.send(payload);
}

module.exports = {
  sendAuthCodeSMS,
  sendAuthCodeMulti,
  // expose helper for tests
  _toE164: toE164,
};
