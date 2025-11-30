// routes/partyLanding.js
const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/p/:partyId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'p.html'));
});

router.get('/p', (req, res) => {
  if (req.query?.party_id) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'p.html'));
  }
  return res.redirect('/');
});

module.exports = router;
