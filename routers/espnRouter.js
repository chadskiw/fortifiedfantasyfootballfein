// routers/espnRouter.js
const express = require('express');
const router = express.Router();

const { getAdapter } = require('../api/platforms'); // points to /api/platforms/index.js

/* ------------------------------ helpers ------------------------------ */
function seasonOf(q) {
  const n = Number(q.season);
  return Number.isFinite(n) ? n : new Date().getUTCFullYear();
}
function weekOf(q) {
  const n = Number(q.week);
  return Number.isFinite(n) ? n : undefined;
}
function limitOf(q, def = 100) {
  const n = Number(q.limit);
  return Number.isFinite(n) ? n : def;
}
function readEspnCookies(req) {
  const swid = req.headers['x-espn-swid'] || req.cookies?.SWID || req.cookies?.swid;
  const s2   = req.headers['x-espn-s2']   || req.cookies?.espn_s2 || req.cookies?.S2;
  return { swid, s2 };
}

/* ------------------------------ debug ------------------------------ */
router.get('/__routes', (_req, res) => {
  res.json({
    ok: true,
    routes: [
      'GET /leagues?season=2025[&leagueId=,leagueId=...]',
      'GET /leagues/:leagueId/teams?season=2025',
      'GET /leagues/:leagueId/teams/:teamId/roster?season=2025&week=2',
      'GET /leagues/:leagueId/matchups?season=2025&week=2',
      'GET /leagues/:leagueId/scoreboard?season=2025&week=2',
      'GET /leagues/:leagueId/freeagents?season=2025&week=2&limit=150',
    ],
  });
});

/* ------------------------------ routes ------------------------------ */
// GET /api/platforms/espn/leagues?season=2025[&leagueId=,...]
router.get('/leagues', async (req, res) => {
  try {
    const season = seasonOf(req.query);
    const leagueIds = (req.query.leagueId || req.query.leagueIds || '')
      .toString()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);
    const out = await api.getLeagues({ season, ...cookies, leagueIds });

    res.json({ ok: true, platform: 'espn', season, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

// GET /api/platforms/espn/leagues/:leagueId/teams?season=2025
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const season = seasonOf(req.query);
    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);

    const out = await api.getTeams({ season, leagueId, ...cookies });
    res.json({ ok: true, platform: 'espn', season, leagueId, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

// GET /api/platforms/espn/leagues/:leagueId/teams/:teamId/roster?season=2025&week=2
router.get('/leagues/:leagueId/teams/:teamId/roster', async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;
    const season = seasonOf(req.query);
    const week = weekOf(req.query);
    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);

    const out = await api.getRoster({ season, leagueId, teamId, week, ...cookies });
    res.json({ ok: true, platform: 'espn', season, leagueId, teamId, week, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

// GET /api/platforms/espn/leagues/:leagueId/matchups?season=2025&week=2
router.get('/leagues/:leagueId/matchups', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const season = seasonOf(req.query);
    const week = weekOf(req.query);
    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);

    const out = await api.getMatchups({ season, leagueId, week, ...cookies });
    res.json({ ok: true, platform: 'espn', season, leagueId, week, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

// GET /api/platforms/espn/leagues/:leagueId/scoreboard?season=2025&week=2
router.get('/leagues/:leagueId/scoreboard', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const season = seasonOf(req.query);
    const week = weekOf(req.query);
    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);

    const out = await api.getScoreboard({ season, leagueId, week, ...cookies });
    res.json({ ok: true, platform: 'espn', season, leagueId, week, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

// GET /api/platforms/espn/leagues/:leagueId/freeagents?season=2025&week=2&limit=150
router.get('/leagues/:leagueId/freeagents', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const season = seasonOf(req.query);
    const week = weekOf(req.query);
    const limit = limitOf(req.query, 100);
    const api = getAdapter('espn');
    const cookies = readEspnCookies(req);

    const out = await api.getFreeAgents({ season, leagueId, week, limit, ...cookies });
    res.json({ ok: true, platform: 'espn', season, leagueId, week, limit, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed' });
  }
});

module.exports = router;
