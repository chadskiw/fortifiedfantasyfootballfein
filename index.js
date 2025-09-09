// index.js
const express = require('express');

const app = express();
app.use(express.json());
// CORS — handles both anonymous and credentialed requests
const ALLOWED = [
  'https://fortifiedfantasy.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function isAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED.includes(origin)) return true;
  // allow your *.pages.dev or other subdomains if needed:
  // if (/\.yourdomain\.pages\.dev$/.test(new URL(origin).hostname)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow-Methods / Allow-Headers for both simple & preflight
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'content-type,x-fein-key,x-espn-swid,x-espn-s2');

  // If caller sends credentials, reflect the exact Origin and allow creds
  if (isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin'); // caches per-origin
  } else {
    // No credentials: safe wildcard
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// import your router
const feinAuthRouter = require('./fein-auth');

// HEALTH
app.get('/health', (_req, res) => res.json({ ok: true, service: 'fein-auth-service' }));

// Mount the SAME router in BOTH places so either URL works:
app.use('/fein-auth', feinAuthRouter);      // e.g. /fein-auth/by-league
app.use('/api/fein-auth', feinAuthRouter);  // e.g. /api/fein-auth/by-league

// 404 (json)
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found', path: req.path }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FEIN Auth listening on :${PORT}`));
