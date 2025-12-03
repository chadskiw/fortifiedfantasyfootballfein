// routes/userLanding.js
const express = require('express');
const path = require('path');
const userOverviewService = require('../services/UserOverviewService');
const Bouncer = require('./Bouncer');

const router = express.Router();

function maskOverviewForAccess(overview, decision) {
  if (!overview) return overview;
  if (!decision || decision.accessLevel === 'full') {
    return overview;
  }

  const masked = {
    ...overview,
    recent_photos: [],
  };

  if (Array.isArray(overview.map_photos)) {
    masked.map_photos = [];
  }

  masked.photo_bounds = { has_geo: false };
  return masked;
}

function buildAccessPayload(decision = {}, req) {
  const viewerId = Bouncer.getViewerId(req);
  const accessLevel = decision.accessLevel || 'limited';
  const isStranger = decision.isStranger !== false;
  const isOwner = !!decision.isOwner;
  const canUseContactMe = !!viewerId && accessLevel !== 'none' && !isStranger;

  return {
    level: accessLevel,
    canRequestContact: !!decision.canRequestContact,
    isStranger,
    isOwner,
    reason: decision.reason || null,
    guardianBlockReason: decision.guardianBlockReason || null,
    viewerIsAuthenticated: !!viewerId,
    canUseContactMe: canUseContactMe && !isOwner,
  };
}

// JSON API: user overview
router.get('/api/users/:memberId/overview', Bouncer.guardMemberPage, async (req, res) => {
  const { memberId } = req.params;
  const accessDecision = req.accessDecision || null;

  try {
    const overview = await userOverviewService.getOverview(memberId);
    if (!overview) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const payload = maskOverviewForAccess(overview, accessDecision);
    payload.access = buildAccessPayload(accessDecision, req);
    res.json(payload);
  } catch (err) {
    console.error('User overview error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// HTML page: /u/:memberId
router.get('/u/:memberId', Bouncer.guardMemberPage, (req, res) => {
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
