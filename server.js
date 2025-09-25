// server.js — FF Platform Service
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Parsers & logs
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
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

// Health & Status
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok:true, name:'ff-platform-service', ts:new Date().toISOString(), espn:{ hasCookies: !!(swid && s2) } });
});

// Routers (canonical locations under src/routes/*)
app.use('/api/session',          require('./src/routes/session'));               // whoami source of truth
app.get(['/whoami','/api/whoami'], (req,res)=>res.redirect(307, '/api/session/whoami'));

app.use('/api/identity',         require('./src/routes/identity/request-code')); // /request-code, /send-code
const qh = require('./src/routes/quickhitter');                                  // /check, /exists, /lookup, /avatar, /qh-upsert
app.use('/api/quickhitter', qh);
app.use('/api/identity',   qh); // alias for legacy FE calls

app.use('/api/members',          require('./src/routes/members'));

app.use('/api/espn',             require('./routes/espn'));                  // consolidated ESPN (dir with index.js)
app.use('/api/platforms/espn',   require('./src/routes/platforms/espn'));        // legacy alias surface
// optional: if login is its own file and not included above
try { app.use('/api/espn/login', require('./routes/espn/login')); } catch (_) {}

// optional debug
try { app.use('/api/debug',      require('./routes/debug/db')); } catch (_) {}

// Static
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// JSON 404 for /api
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// Errors
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// Boot
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
