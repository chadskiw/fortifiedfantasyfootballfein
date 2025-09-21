// routes/identity/contacts.js
const express = require('express');
const router = express.Router();

// Health check for your sanity
router.get('/contacts/ping', (req, res) => res.json({ ok: true }));

// Optional: quick echo endpoint you can remove later
router.post('/contacts/echo', (req, res) => {
  res.json({ ok: true, body: req.body || null });
});

module.exports = router;
