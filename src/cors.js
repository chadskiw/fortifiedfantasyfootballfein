// src/cors.js

// Build allow-list from env + defaults
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_ALLOWED = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy4.pages.dev',
];

const ALLOWED = [...new Set([...DEFAULT_ALLOWED, ...ENV_ALLOWED])];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED.includes(origin)) return true;

  try {
    const { hostname } = new URL(origin);
    if (hostname.endsWith('.pages.dev')) return true;
    if (hostname === 'fortifiedfantasy.com') return true;
    if (hostname.startsWith('fortifiedfantasy.')) return true;
  } catch {
    return false;
  }

  return false;
}

function corsMiddleware(req, res, next) {
  // ✅ req is always defined here
  const origin = req.headers.origin || '';

  res.setHeader('Vary', 'Origin');

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key'
  );
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

module.exports = { corsMiddleware };
