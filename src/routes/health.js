// src/routes/health.js
import { Router } from 'express';
import os from 'os';

const STARTED_AT = Date.now();
const SERVICE = process.env.SERVICE_NAME || 'fein-auth-service';

export default function buildHealthRouter({ pool } = {}) {
  const router = Router();

  router.head('/health', (req, res) => res.sendStatus(200));
  router.get('/health', (req, res) => {
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

  router.get('/health/db', async (req, res) => {
    if (!pool) return res.json({ ok: true, db: 'skipped' });
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'db_down', detail: String(e) });
    }
  });

  router.get('/health/ready', async (req, res) => {
    try {
      if (pool) await pool.query('SELECT 1');
      res.json({ ok: true, ready: true });
    } catch (e) {
      res.status(503).json({ ok: false, ready: false, error: 'dependency_failed', detail: String(e) });
    }
  });

  return router;
}
