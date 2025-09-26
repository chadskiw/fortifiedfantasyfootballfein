// lib/notifier.js
// One-time NotificationAPI client init, CommonJS-safe

let notificationapi = require('notificationapi-node-server-sdk');
notificationapi = notificationapi.default || notificationapi; // handle CJS/ESM seamlessly

// allow either naming in .env
const CLIENT_ID     = process.env.NOTIFICATIONAPI_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.NOTIFICATIONAPI_CLIENT_SECRET || process.env.CLIENT_SECRET;

// (optional) override base URL if you use a regional endpoint
// const BASE_URL = process.env.NOTIFICATIONAPI_BASE_URL; // e.g. "https://api.notificationapi.com"

// init once
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[notifier] missing NOTIFICATIONAPI_CLIENT_ID / NOTIFICATIONAPI_CLIENT_SECRET');
} else {
  try {
    // Both signatures work; the 2-arg form uses default base URL
    notificationapi.init(CLIENT_ID, CLIENT_SECRET /*, BASE_URL */);
  } catch (e) {
    console.error('[notifier] init failed:', e);
  }
}

module.exports = notificationapi;
