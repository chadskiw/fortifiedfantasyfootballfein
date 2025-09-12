const express = require('express');
const feinAuthRouter = require('./routes/fein-auth');
const feinReact = require('./routes/feinReact');
const espnProxy = require('./routes/espn-proxy');
const espnOpponents = require('./routes/espn-opponents');

const app = express();
app.use(express.json());
app.use('/api', require('./routes/espn-proxy'));
// FEIN calls: GET /api/free-agents?leagueId=...&season=...&week=...&teamId=...


// ---- CORS (GLOBAL) — put this BEFORE any routes ----
const ALLOWED = [
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy4.pages.dev', // no trailing slash
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function normalizeOrigin(o) { return o ? o.replace(/\/$/, '') : ''; }
function isAllowed(origin) {
  const o = normalizeOrigin(origin);
  return o && ALLOWED.includes(o);
}

app.use((req, res, next) => {
  const origin = normalizeOrigin(req.headers.origin);
  // Methods/headers you accept
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-fein-key,x-espn-swid,x-espn-s2');
  // If you ever read response headers in frontend, expose them:
  // res.setHeader('Access-Control-Expose-Headers', 'content-type');

  if (isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    // If you need credentials, you cannot use "*". If not, "*" is fine.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- Health
app.get('/health', (_req, res) => res.json({ ok: true, service: 'fein-auth-service' }));

// ---- Routes
app.use('/api/fein', feinReact);
app.use('/fein-auth', feinAuthRouter);
app.use('/api/fein-auth', feinAuthRouter);
app.use('/espn', espnProxy);
app.use('/espn', espnOpponents);
// server/app.js
app.use('/api/espn-auth', require('./routes/espn-auth'));

// ---- 404
app.use((req, res) => res.status(404).json({ ok:false, error:'Not Found', path:req.path }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`fein-auth-service listening on :${PORT}`));
