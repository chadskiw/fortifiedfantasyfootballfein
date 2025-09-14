// src/api/platforms/index.js
const express = require('express');
const path = require('path');

const router = express.Router();

// quick liveness for the /api/platforms scope
router.get('/__alive', (_req, res) => res.json({ ok: true, scope: '/api/platforms' }));

// Load ESPN router (router file lives at src/routers/espnRouter.js)
const espnRouter = require(path.join(__dirname, '../../routers/espnRouter'));

// Mount sub-routers
router.use('/espn', espnRouter);

// List mounts (note: this belongs to the platforms router, not espnRouter)
router.get('/__routes', (_req, res) => {
  res.json({ ok: true, mounts: ['/api/platforms/espn'] });
});

module.exports = router;
