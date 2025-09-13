// server.js
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
const platformRouter = require('./src/routes/platforms');
const { ping } = require('./src/db');

const app = express();
app.disable('x-powered-by');

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware); // call the factory to get the middleware
app.use(rateLimit);          // <-- MUST be the function, not the module
// Static assets (if desired)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// Health
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/db/ping', async (_req, res) => {
  try { res.json({ ok: await ping() }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Multi-platform API
app.use('/api/platforms', platformRouter);

// 404 + errors
app.use((req, res) => res.status(404).json({ ok:false, error:'Not found' }));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ ok:false, error: err.message || 'Server error' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FF Service on :${PORT}`));
