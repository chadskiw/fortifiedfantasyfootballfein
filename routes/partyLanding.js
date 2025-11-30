// routes/partyLanding.js
const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/p/:partyId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'p.html'));
});

// optional: /p -> maybe redirect to host's current party or home
router.get('/p', (req, res) => {
  return res.redirect('/');
});

module.exports = router;
