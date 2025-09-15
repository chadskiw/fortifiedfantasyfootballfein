// server.js
require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const cookieParser = require('cookie-parser');

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
const platformRouter     = require('./src/routes/platforms');
const espnRouter         = require('./routers/espnRouter');
const feinAuthRouter     = require('./routes/fein-auth');

// (Optional) light gate so headers are present for ESPN platform routes only
const requireEspnHeaders = (req, res, next) =>
  (!req.get('x-espn-swid') || !req.get('x-espn-s2'))
    ? res.status(401).json({ ok:false, error:'Missing x-espn-swid or x-espn-s2' })
    : next();

const app = express();
app.disable('x-powered-by');

// If you’re behind a proxy/Cloudflare/Heroku/etc, enable trust proxy so secure cookies work
app.set('trust proxy', 1);

// --- Parsers & infra middlewares
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());              // <- REQUIRED for /api/fein-auth to read cookies
app.use(corsMiddleware);
app.use(rateLimit);

// --- ✅ Mount API routers BEFORE any static or SPA fallback
app.use('/api/fein-auth', feinAuthRouter);                 // same-origin cookie endpoints + meta upsert
app.use('/api/platforms/espn', requireEspnHeaders, espnRouter);
// If/when you restore other platforms aggregate router:
// app.use('/api/platforms', platformRouter);

// --- Static AFTER APIs (so /api/* never hits the static handler)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// --- Health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
