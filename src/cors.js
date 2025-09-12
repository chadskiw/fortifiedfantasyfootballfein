// src/cors.js
const ALLOW_LIST = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOW_LIST.includes(origin)) return true;

  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.pages.dev') && u.hostname.includes('fortifiedfantasy')) {
      return true;
    }
  } catch (_) {}
  return false;
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-fein-key,x-espn-swid,x-espn-s2');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { corsMiddleware, isAllowedOrigin };
