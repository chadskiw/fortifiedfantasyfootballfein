// lib/notifier.js
const NotificationApi = require('notificationapi-node-server-sdk'); // npm i notificationapi-node-server-sdk

const client = new NotificationApi(
  process.env.NOTIFICATIONAPI_CLIENT_ID,
  process.env.NOTIFICATIONAPI_CLIENT_SECRET
);

// One function we can “fire-and-forget”
async function sendVerifyCode({ to, code, channel, ttlMinutes = 10 }) {
  // `type` (aka notification ID) must match what you configure in NotificationAPI dashboard
  const type = process.env.NOTIFICATIONAPI_VERIFY_TYPE || 'ff_verify_code';

  // Build user shape for either email or sms
  const user = { id: to };
  if (/^\+?[1-9]\d{6,}$/.test(to)) user.phoneNumber = to;
  else user.email = to;

  // DO NOT await this where you need low latency (let caller decide)
  return client.send({
    type,                 // your configured notification type
    to: user,             // { id, email? / phoneNumber? }
    parameters: {         // merge tags used by your template
      code,
      codeTTL: ttlMinutes,
      appName: 'Fortified Fantasy'
    },
    // optional: force channels for this notification
    overrides: channel === 'sms' ? { channels: { email: { send: false }, sms: { send: true } } }
                                 : channel === 'email' ? { channels: { email: { send: true }, sms: { send: false } } }
                                 : undefined
  });
}

module.exports = { sendVerifyCode };
