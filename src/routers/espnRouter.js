const express = require('express');
const espn = require('../api/platforms/espn'); // your adapter
const router = express.Router();

// sanity check
router.get('/', (_req, res) => res.json({ ok: true, platform: 'espn' }));

// example route
router.get('/leagues/:leagueId/teams', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const { leagueId } = req.params;
    const swid = req.get('x-espn-swid');
    const s2 = req.get('x-espn-s2');

    const data = await espn.getTeams({ season, leagueId, swid, s2 });
    res.json({ ok: true, platform: 'espn', ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Failed to fetch teams' });
  }
});

module.exports = router; // <--- just export router
