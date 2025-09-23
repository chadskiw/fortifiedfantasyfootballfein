// routes/health.js  (CommonJS)
const express = require('express');
const os = require('os');

const STARTED_AT = Date.now();
const SERVICE = process.env.SERVICE_NAME || 'fein-auth-service';

/**
 * Build the /api/health router.
 * Usage in server.js:
 *   app.use('/api', require('./routes/health')({ pool }));
 */
module.exports = function buildHealthRouter({ pool } = {}) {
  const router = express.Router();

  // Fast liveness (HEAD is useful for load balancers)
  router.head('/health', (_req, res) => res.sendStatus(200));
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: SERVICE,
      time: new Date().toISOString(),
      uptime_ms: Date.now() - STARTED_AT,
      pid: process.pid,
      node: process.version,
      host: os.hostname(),
      memory_rss: process.memoryUsage().rss,
    });
  });

  // DB readiness probe
  router.get('/health/db', async (_req, res) => {
    if (!pool) return res.json({ ok: true, db: 'skipped' });
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'db_down', detail: String(e) });
    }
  });

  // Full readiness (add other dependencies checks here if needed)
  router.get('/health/ready', async (_req, res) => {
    try {
      if (pool) await pool.query('SELECT 1');
      res.json({ ok: true, ready: true });
    } catch (e) {
      res.status(503).json({ ok: false, ready: false, error: 'dependency_failed', detail: String(e) });
    }
  });

  return router;
};
