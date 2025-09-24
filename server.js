// server.js — add whoami, keep identity

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

// Identity
app.use('/api/identity', require('./src/routes/identity/request-code'));

// WhoAmI (root + api alias)
const whoami = require('./routes/whoami');
app.use('/', whoami);
app.use('/api/whoami', whoami);

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
