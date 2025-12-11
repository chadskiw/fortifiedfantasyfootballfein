// routes/partyPeople.js
const path = require('path');
const express = require('express');
const router = express.Router();

router.get('/partyPeople', async (req, res, next) => {
  try {
    const memberId = req.query.member_id || '';
    const headerless =
      req.query.headerless === '1' || req.query.headerless === 'true';

    res.sendFile(
      path.join(__dirname, '..', 'public', 'partyPeople.html'),
      err => {
        if (err) next(err);
      },
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
