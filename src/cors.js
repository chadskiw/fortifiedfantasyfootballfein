// src/cors.js

// Build an allow-list from ENV plus sensible defaults
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Defaults you likely want in dev/prod
const DEFAULT_ALLOWED = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy4.pages.dev',
];

const ALLOWED = [...new Set([...DEFAULT_ALLOWED, ...ENV_ALLOWED])];

// Wildcard tests for your domains
function isWildcardAllowed(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);

    // allow *.pages.dev (e.g., Cloudflare Pages preview/envs)
    if (u.hostname.endsWith('.pages.dev')) return true;

    // allow fortifiedfantasy.* (e.g., fortifiedfantasy.com, fortifiedfantasy.net)
    if (u.hostname === 'fortifiedfantasy.com') return true;
    if (u.hostname.startsWith('fortifiedfantasy.')) return true;

    return false;
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return false; // curl/SSR without Origin header -> no CORS needed
  if (ALLOWED.includes(origin)) return true;
  if (isWildcardAllowed(origin)) return true;
  // Allow "*" if explicitly configured
  if (ALLOWED.includes('*')) return true;
  return false;
}

function corsMiddleware(req, res, next) {
  // IMPORTANT: Only read req inside the middleware
  const origin = req.headers?.origin;

  // Always vary on Origin so caches don’t mix responses
  res.setHeader('Vary', 'Origin');

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Methods + headers (broad but safe)
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key'
  );
  res.setHeader('Access-Control-Max-Age', '600'); // cache preflight 10m

  // Handle preflight early
  if (req.method === 'OPTIONS') {
    // If Origin was allowed, return 204; otherwise still OK to end quietly
    return res.status(204).end();
  }

  next();
}

module.exports = { corsMiddleware, isAllowedOrigin };
