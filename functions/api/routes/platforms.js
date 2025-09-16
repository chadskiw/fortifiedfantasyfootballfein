// functions/api/routes/platforms.js
const express = require('express');
const router = express.Router();
const { getAdapter } = require('../platforms');

function pickCookies(req) {
  // Accept from either cookies or proxy headers the FE can set
  const swid = req.cookies?.SWID || req.cookies?.swid || req.headers['x-espn-swid'];
  const s2   = req.cookies?.espn_s2 || req.headers['x-espn-s2'];
  return { swid, s2 };
}

// GET /api/platforms/:platform/leagues?season=2025
router.get('/:platform/leagues', async (req, res) => {
  try {
    const { platform } = req.params;
    const { season } = req.query;
    const ctx = { season: Number(season) || new Date().getFullYear(), ...pickCookies(req) };
    const api = getAdapter(platform);
    const leagues = await api.getLeagues(ctx);
    res.json({ platform, season: ctx.season, leagues });
  } catch (err) {
    const msg = err?.message || 'Failed to fetch leagues';
    res.status(400).json({ ok: false, error: msg });
  }
});

// GET /api/platforms/:platform/:leagueId/teams
router.get('/:platform/:leagueId/teams', async (req, res) => {
  try {
    const { platform, leagueId } = req.params;
    const { season } = req.query;
    const ctx = { season: Number(season) || new Date().getFullYear(), leagueId, ...pickCookies(req) };
    const api = getAdapter(platform);
    const teams = await api.getTeams(ctx);
    res.json({ leagueId, season: ctx.season, teams });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to fetch teams' });
  }
});

// GET /api/platforms/:platform/:leagueId/teams/:teamId/roster?scope=week|season&week=2
router.get('/:platform/:leagueId/teams/:teamId/roster', async (req, res) => {
  try {
    const { platform, leagueId, teamId } = req.params;
    const { season, scope = 'week', week } = req.query;
    const ctx = {
      season: Number(season) || new Date().getFullYear(),
      scope, week: week ? Number(week) : null,
      leagueId, teamId, ...pickCookies(req),
    };
    const api = getAdapter(platform);
    const players = await api.getRoster(ctx);
    res.json({ leagueId, teamId, season: ctx.season, scope, week: ctx.week, players });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to fetch roster' });
  }
});

// GET /api/platforms/:platform/:leagueId/league-rosters
router.get('/:platform/:leagueId/league-rosters', async (req, res) => {
  try {
    const { platform, leagueId } = req.params;
    const { season } = req.query;
    const ctx = { season: Number(season) || new Date().getFullYear(), leagueId, ...pickCookies(req) };
    const api = getAdapter(platform);
    const rosters = await api.getLeagueRosters(ctx);
    res.json({ leagueId, season: ctx.season, rosters });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to fetch league rosters' });
  }
});

// GET /api/platforms/:platform/players/search?q=smith
router.get('/:platform/players/search', async (req, res) => {
  try {
    const { platform } = req.params;
    const { q = '', season } = req.query;
    const ctx = { season: Number(season) || new Date().getFullYear(), q, ...pickCookies(req) };
    const api = getAdapter(platform);
    const players = await api.searchPlayers(ctx);
    res.json({ season: ctx.season, q, players });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Search failed' });
  }
});

module.exports = router;
