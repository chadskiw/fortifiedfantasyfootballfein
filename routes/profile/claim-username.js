// routes/profile/claim-username.js (CommonJS)
const express = require('express');
const identityHandleRouter = require('../identity/handle');
const router = express.Router();

// Delegate POST /api/profile/claim-username -> /api/identity/handle/upsert
router.post('/claim-username', express.json(), (req, res, next) => {
  req.url = '/handle/upsert';
  return identityHandleRouter(req, res, next);
});

module.exports = router;
