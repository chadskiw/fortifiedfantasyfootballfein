// server.js
require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const pinoHttp = require('pino-http')();
const { ping, q } = require('./src/db');

const { corsMiddleware } = require('./src/cors');
const { rateLimit } = require('./src/rateLimit');
const platformRouter = require('./src/routes/platforms');

const app = express();

app.disable('x-powered-by');

// Core middleware
app.use(pinoHttp);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware);
app.use(rateLimit);

// Static (optional)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// Health
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// API routes (multi-platform ready: espn, sleeper, yahoo, mfl)
app.use('/api/platforms', platformRouter);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Error handler
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'Unhandled error');
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FF Platform Service listening on :${PORT}`);
});

app.get('/db/ping', async (req, res) => {
  try {
    const ok = await ping();
    res.json({ ok, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Optional: quick introspection (remove in prod if you prefer):
app.get('/db/info', async (_req, res) => {
  try {
    const r = await q('select current_database() as db, current_user as user, inet_server_addr()::text as host, inet_server_port() as port');
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});