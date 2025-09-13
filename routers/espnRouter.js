// routers/sleeperRouter.js
const express = require('express');
const router = express.Router();

const { getAdapter } = require('../api/platforms'); // CJS import of adapters index
const sleeper = getAdapter('sleeper'); // make sure the sleeper adapter exists

// Health
router.get('/__alive', (_req, res) => {
  res.json({ ok: true, scope: '/api/platforms/sleeper' });
});

// GET /api/platforms/sleeper/leagues?season=2025
router.get('/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season);
    if (!Number.isFinite(season)) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid ?season' });
    }
    const leagues = await sleeper.getLeagues({ season });
    res.json({ ok: true, platform: 'sleeper', season, leagues });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch leagues' });
  }
});

// GET /api/platforms/sleeper/leagues/:leagueId/teams?season=2025
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.params.leagueId || '').trim();
    if (!Number.isFinite(season)) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid ?season' });
    }
    if (!leagueId) {
      return res.status(400).json({ ok: false, error: 'Missing :leagueId' });
    }

    const teams = await sleeper.getLeagueTeams({ season, leagueId });
    res.json({ ok: true, platform: 'sleeper', season, leagueId, teams });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch teams' });
  }
});

module.exports = router; // <-- important
