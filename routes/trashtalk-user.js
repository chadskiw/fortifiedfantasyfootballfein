// routes/trashtalk-user.js (for example)
const path = require('path');
const express = require('express');
const router = express.Router();

router.get('/u/:memberId', (req, res) => {
  // optional: guard if no ff_member_id cookie, redirect to '/'
  if (!req.cookies?.ff_member_id) {
    return res.redirect('/');
  }

  res.sendFile(
    path.join(__dirname, '..', 'public', 'trashtalk', 'u.html')
  );
});

module.exports = router;
