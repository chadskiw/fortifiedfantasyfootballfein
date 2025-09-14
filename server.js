// server.js
require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
const platformRouter     = require('./src/routes/platforms');

const app = express();
app.disable('x-powered-by');

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware);
app.use(rateLimit);

// static (optional)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ✅ Mount all platform routes (currently only ESPN is active)
app.use('/api/platforms', platformRouter);

// health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
