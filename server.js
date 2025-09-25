// server.js — FF Platform Service (identity + whoami + espn)
// ---------------------------------------------------------
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// logging + parsers
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options('*', (req, res) => res.set(allow).sendStatus(204));
app.use((req, res, next) => { res.set(allow); next(); });

// health
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---- APIs ----

// Identity (request/send code)
app.use('/api/identity', require('./src/routes/identity/request-code'));

// WhoAmI (root + alias)
//   GET /check
//   GET /lookup?identifier=...
const whoami = require('./routes/whoami');
app.use('/', whoami);
app.use('/api/whoami', whoami);

// ESPN (root + /api/espn):
//   GET /status           (also /api/espn/status)
//   GET /login            (also /api/espn/login)
//   GET /leagues?season=2025 (also /api/espn/leagues?season=2025)
// server.js
const espnRouter = require('./src/routes/espn');
const espnLog = require('./src/routes/espn/login');

// Modern routes
app.use('/api/identity', require('./src/routes/quickhitter'));
app.use('/api/session',  require('./routes/session')); // if you added it earlier

// Legacy/compat aliases
app.use('/api/platforms/espn', require('./src/routes/platforms/espn')); // fixes /api/platforms/espn/*
// server.js
app.use('/api/quickhitter', require('./src/quickhitter.js'));
app.use('/api/members',        require('./src/routes/members')); // fixes /api/members/lookup


// (optional) make sure body parsers exist once globally:
// app.use(express.json({ limit: '5mb' }));
// app.use(express.urlencoded({ extended:false }));

// PRIMARY mount (all ESPN endpoints live here)
app.use('/api/debug', require('./src/routes/debug/db'));
app.use('/api/espn/login', espnLog);
// Root service status (fixes your /status 404 without polluting /login)
app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    name: 'ff-platform-service',
    ts: new Date().toISOString(),
    espn: { hasCookies: !!(swid && s2) }
  });
});


// static
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// JSON 404 for /api
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// errors
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
