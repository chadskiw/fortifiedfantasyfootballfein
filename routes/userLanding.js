// routes/userLanding.js
const express = require('express');
const path = require('path');
const userOverviewService = require('../services/UserOverviewService');

const router = express.Router();

// JSON API: user overview
router.get('/api/users/:memberId/overview', async (req, res) => {
  const { memberId } = req.params;

  try {
    const overview = await userOverviewService.getOverview(memberId);
    res.json(overview);
  } catch (err) {
    console.error('User overview error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// HTML page: /u/:memberId
router.get('/u/:memberId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'u.html'));
});

// Optional: /u -> current user's page
router.get('/u', (req, res) => {
  if (req.user && req.user.member_id) {
    return res.redirect(`/u/${encodeURIComponent(req.user.member_id)}`);
  }
  return res.redirect('/');
});

module.exports = router;
