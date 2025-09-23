// /src/notify.js
// Lightweight wrapper around NotificationAPI (server SDK)

let notificationapi = null;
function lazyInit() {
  if (notificationapi) return notificationapi;

  // The SDK exports a default
  try {
    notificationapi = require('notificationapi-node-server-sdk').default;
  } catch (e) {
    console.error('[notify] Could not load notificationapi-node-server-sdk:', e);
    notificationapi = null;
    return null;
  }

  const clientId = process.env.NOTIFICATIONAPI_CLIENT_ID || process.env.NOTIFICATION_API_CLIENT_ID;
  const clientSecret = process.env.NOTIFICATIONAPI_CLIENT_SECRET || process.env.NOTIFICATION_API_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('[notify] NotificationAPI credentials missing; emails will be skipped.');
    return notificationapi; // allow calls but they will early-return
  }

  try {
    notificationapi.init(clientId, clientSecret);
  } catch (e) {
    console.error('[notify] NotificationAPI.init failed:', e);
  }
  return notificationapi;
}

/**
 * Send "Teams Update" email to the given address with the provided HTML (or text) body.
 * Uses overrides so you don’t need to rely on a dashboard template.
 * 
 * @param {object} params
 * @param {string} [params.toEmail] - default: process.env.NOTIFICATIONAPI_DEFAULT_TO or fortifiedfantasy@gmail.com
 * @param {string} [params.subject] - default: 'Teams Update'
 * @param {string} [params.html]    - HTML body. If you only have plain text, pass it and we’ll wrap it.
 */
async function sendTeamsUpdateEmail({ toEmail, subject, html } = {}) {
  const api = lazyInit();
  if (!api) return false;

  const emailTo = toEmail || process.env.NOTIFICATIONAPI_DEFAULT_TO || 'fortifiedfantasy@gmail.com';
  const typeId  = process.env.NOTIFICATIONAPI_TYPE_TEAMS_UPDATE || 'teams_update';

  const htmlBody = (html && String(html).trim())
    ? html
    : '<p>No content</p>';

  try {
    await api.send({
      // Any valid notification type ID in your NotificationAPI project.
      // We supply full overrides below, so the template contents aren’t required.
      type: typeId,
      to: {
        id: 'ff-system',
        email: emailTo,
      },
      email: {
        subject: subject || 'Teams Update',
        html: htmlBody,
        // Optional from-override if you’ve set a verified sender on NotificationAPI:
        // senderName: process.env.NOTIFICATIONAPI_SENDER_NAME || 'Fortified Fantasy',
        // senderEmail: process.env.NOTIFICATIONAPI_SENDER_EMAIL || 'no-reply@fortifiedfantasy.com',
      },
    });
    return true;
  } catch (e) {
    console.error('[notify] sendTeamsUpdateEmail failed:', e);
    return false;
  }
}

module.exports = {
  sendTeamsUpdateEmail,
};
