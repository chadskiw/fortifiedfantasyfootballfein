// server.js
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// logging + parsers
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Global OPTIONS for /api/*
app.options('/api/*', (req, res) => {
  const origin = req.headers.origin || '*';
  res.set({
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type,Authorization'
  }).status(204).end();
});
// simple CORS echo for actual API routes
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin || '*';
  res.set({
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Credentials': 'true'
  });
  next();
});

// ---- ROUTES ----
app.use('/api/identity', require('./src/routes/identity'));  // exists + upsert
app.use('/api/images',   require('./src/routes/images'));    // presign + commit

// Health BEFORE static
app.get('/healthz', async (_req, res) => {
  res.json({ ok:true, ts: new Date().toISOString() });
});

// Static (if you serve anything at all from Render)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// JSON 404 for /api
app.use('/api', (req, res) => res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({ ok:false, error:'server_error', message: err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));
