// src/cors.js
const ALLOWED = new Set([
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000'
]);

// Optional: allow subdomains like fortifiedfantasy4.pages.dev
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED.has(origin)) return true;
  try {
    const u = new URL(origin);
    // allow any subdomain of pages.dev for this project
    if (u.hostname.endsWith('fortifiedfantasy.pages.dev')) return true;
  } catch {}
  return false;
}

function setCORSHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); // echo exact origin
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin'); // important for caches
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    [
      'accept',
      'accept-language',
      'content-type',
      'x-requested-with',
      'x-espn-swid',
      'x-espn-s2',
      'x-fein-key',
      'authorization'
    ].join(', ')
  );
}

function corsMiddleware(req, res, next) {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') {
    // Preflight: reply immediately with 204 + headers
    return res.status(204).end();
  }
  next();
}

module.exports = { corsMiddleware, isAllowedOrigin };
