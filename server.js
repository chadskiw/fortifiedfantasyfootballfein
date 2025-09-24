// server.js — FF Platform Service (cleaned)
// ----------------------------------------
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const path         = require('path');
const cookieParser = require('cookie-parser');

const { pool }     = require('./src/db/pool'); // single source of truth pg pool
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---- logging + body parsers (tolerant JSON) ----
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb', strict: false }));
app.use(function jsonParseGuard(err, req, _res, next) {
  if (err && err.type === 'entity.parse.failed') {
    req._badJsonRaw = err.body || '';
    req.body = {};
    return next();
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---- tiny helpers used in a couple places ----
function coerceJsonMaybe(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}
function parseLooseObjectish(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();

  // {key:value}
  let m = /^\{?\s*([^:{}"'\s]+)\s*:\s*(.+?)\s*\}?$/.exec(trimmed);
  if (m) {
    const k = String(m[1]).trim();
    let v = String(m[2]).trim();
    v = v.replace(/^"(.*)"$/,'$1').replace(/^'(.*)'$/,'$1');
    return { [k]: v };
  }
  // key=value
  m = /^([^=]+)=(.+)$/.exec(trimmed);
  if (m) return { [m[1].trim()]: m[2].trim() };
  // fallback
  return trimmed ? { value: trimmed } : null;
}
function readAnyBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  const raw = (typeof req.body === 'string' && req.body) || req._badJsonRaw || '';
  const j = coerceJsonMaybe(raw);
  if (j && typeof j === 'object') return j;
  const loose = parseLooseObjectish(raw);
  if (loose) return loose;
  return {
    ...((req.body && typeof req.body === 'object') ? req.body : {}),
    ...req.query,
  };
}
function normalizeBody(req, _res, next) { req.body = readAnyBody(req); next(); }

// ---- CORS (simple, explicit) ----
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options('*', (req, res) => res.set(allow).sendStatus(204));
app.use((req, res, next) => { res.set(allow); next(); });

// ---- Health first (fast, before other routes) ----
app.get('/healthz', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows[0]?.ok === 1, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message, ts: new Date().toISOString() });
  }
});

// ---- Identity API (single source of truth) ----
// File TRUE_LOCATION: routes/identity-api.js
const identityRouter = require('./routes/identity-api');

// Mount the whole identity router
app.use('/api/identity', normalizeBody, identityRouter);

// Alias: /api/identity/send-code → same handler as /api/identity/request-code
// (This forwards into the mounted router by rewriting the URL)
app.post('/api/identity/send-code', normalizeBody, (req, res, next) => {
  req.url = '/request-code';
  identityRouter(req, res, next);
});

// ---- (Optional) add other APIs here, when those files exist ----
// e.g. app.use('/api/espn-auth', require('./routes/fein-auth'));
// e.g. app.use('/api/image', require('./routes/image-upsert'));

// ---- Static AFTER APIs ----
app.use('/fein', express.static(path.join(__dirname, 'public/fein'), {
  immutable: true, maxAge: '4h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js'))  res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
    if (filePath.endsWith('.wasm')) res.type('application/wasm');
  }
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ---- JSON 404 for /api ----
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// ---- Error handler ----
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error: (err.status === 400 ? 'bad_request' : 'server_error') });
});

// ---- Start ----
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
