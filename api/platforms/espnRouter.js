CHECK THIS OUT
// TRUE_LOCATION: api/platforms/espnRouter.js
// IN_USE: FALSE
// src/routers/espnRouter.js
const express = require('express');
const espn = require('../api/platforms/espn'); // <- your adapter from src/api/platforms/espn.js

const router = express.Router();

// sanity
router.get('/', (_req, res) => res.json({ ok: true, platform: 'espn' }));

// GET /api/platforms/espn/leagues/:leagueId/teams?season=2025
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.params.leagueId || '');
    if (!Number.isFinite(season)) return res.status(400).json({ ok:false, error:'Missing or invalid ?season' });

    const swid = req.get('x-espn-swid');
    const s2   = req.get('x-espn-s2');

    const data = await espn.getTeams({ season, leagueId, swid, s2 });
    return res.json({ ok:true, platform:'espn', ...data });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'Failed to fetch teams' });
  }
});

// (optional) more routes:
router.get('/leagues/:leagueId/roster/:teamId', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const week   = req.query.week ? Number(req.query.week) : undefined;
    const { leagueId, teamId } = req.params;
    const swid = req.get('x-espn-swid'); const s2 = req.get('x-espn-s2');
    const data = await espn.getRoster({ season, leagueId, teamId, week, swid, s2 });
    res.json({ ok:true, platform:'espn', ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'Failed to fetch roster' });
  }
});

router.get('/leagues/:leagueId/matchups', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const week   = req.query.week ? Number(req.query.week) : undefined;
    const { leagueId } = req.params;
    const swid = req.get('x-espn-swid'); const s2 = req.get('x-espn-s2');
    const data = await espn.getMatchups({ season, leagueId, week, swid, s2 });
    res.json({ ok:true, platform:'espn', ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'Failed to fetch matchups' });
  }
});

router.get('/leagues/:leagueId/scoreboard', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const week   = req.query.week ? Number(req.query.week) : undefined;
    const { leagueId } = req.params;
    const swid = req.get('x-espn-swid'); const s2 = req.get('x-espn-s2');
    const data = await espn.getScoreboard({ season, leagueId, week, swid, s2 });
    res.json({ ok:true, platform:'espn', ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'Failed to fetch scoreboard' });
  }
});

module.exports = router;

router.get('/leagues/:leagueId/free-agents', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const week   = req.query.week ? Number(req.query.week) : undefined;
    const limit  = req.query.limit ? Number(req.query.limit) : 100;
    const { leagueId } = req.params;
    const swid = req.get('x-espn-swid'); const s2 = req.get('x-espn-s2');
    const data = await espn.getFreeAgents({ season, leagueId, week, swid, s2, limit });
    res.json({ ok:true, platform:'espn', ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'Failed to fetch free agents' });
  }
});

module.exports = router; // <-- IMPORTANT: export the router (a function)
