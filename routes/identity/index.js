// TRUE_LOCATION: routes/identity/index.js
// IN_USE: TRUE
const express = require('express');
const router = express.Router();

// Subroutes
router.use('/request-code', require('./request-code')); // POST /api/identity/request-code

// Optional ping
router.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = router;
