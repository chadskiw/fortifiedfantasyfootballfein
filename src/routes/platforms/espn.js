// src/routes/platforms/espn.js
// Legacy alias router so old FE calls like /api/platforms/espn/* keep working.
// It mounts the modern ESPN router at this path and adds a few shim endpoints.

const express = require('express');
const router  = express.Router();
const espnRouter = require('../espn'); // resolves to src/routes/espn/index.js

// Mount the modern routes under this legacy base:
// -> /api/platforms/espn/status, /leagues, /discover, /link, /login
router.use('/', espnRouter);

// Legacy shims used by older FE:
router.get('/cred', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, hasCookies: !!(swid && s2) });
});

router.get('/authcheck', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, step: (swid && s2) ? 'logged_in' : 'link_needed' });
});

module.exports = router;
