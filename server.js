// server.js
require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
const platformRouter     = require('./src/routes/platforms');
const espnRouter = require('./src/routers/espnRouter');
// (Optional) light gate so headers are present
const requireEspnHeaders = (req, res, next) =>
  (!req.get('x-espn-swid') || !req.get('x-espn-s2'))
    ? res.status(401).json({ ok:false, error:'Missing x-espn-swid or x-espn-s2' })
    : next();
const app = express();
app.disable('x-powered-by');

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware);
app.use(rateLimit);

// static (optional)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// MOUNT the real ESPN routes:
app.use('/api/platforms/espn', requireEspnHeaders, espnRouter);
/* ✅ Mount all platform routes (currently only ESPN is active)
app.use('/api/platforms', platformRouter);
// MOUNT the real ESPN routes:
app.use('/api/platforms/espn', requireEspnHeaders, espnRouter);
*/
// health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
