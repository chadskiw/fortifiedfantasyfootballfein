// routers/healthRouter.js
const express = require('express');
const router = express.Router();

/**
 * Health Router
 * Scope: /api/platforms/health
 */

// GET /api/platforms/health/__alive
router.get('/__alive', (_req, res) => {
  res.json({ ok: true, scope: '/api/platforms/health' });
});

// Example extended health check
router.get('/check', async (_req, res) => {
  try {
    // TODO: add DB or service checks if needed
    res.json({ ok: true, status: 'healthy', ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Health check failed' });
  }
});

module.exports = router;   // <-- Important: CommonJS export