// routes/partyLanding.js
const express = require('express');
const path = require('path');
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();
async function requireIdentity(req, res) {
  const me = await getCurrentIdentity(req, pool);
if (!me) return res.status(401).json({ error: 'Not logged in' });
  return me;
}
router.get('/p/:partyId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'p.html'));
});
// in routes/partyLanding.js or similar
router.get('/p', requireIdentity, (req, res) => {
    if (req.query?.party_id) {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'p.html'));
    }
  return res.redirect('/');
});

module.exports = router;
