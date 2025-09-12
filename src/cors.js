// src/cors.js
const ALLOW_LIST = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/*
 * We can’t use wildcards with credentials, so we implement pattern checks:
 * - fortifedfantasy.com
 * - localhost dev ports
 * - *.pages.dev (specific project subdomains)
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOW_LIST.includes(origin)) return true;

  try {
    const u = new URL(origin);
    // Allow *.pages.dev for your Cloudflare Pages project
    if (u.hostname.endsWith('.pages.dev') && u.hostname.includes('fortifiedfantasy')) return true;
    // You can add other patterns here as needed
  } catch (_) { /* ignore */ }

  return false;
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type,authorization,x-fein-key,x-espn-swid,x-espn-s2'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { corsMiddleware };
