// src/routes/platforms.js
const express = require('express');
const { getAdapter } = require('../platforms');

const router = express.Router();

function readAuth(platform, req) {
  switch (platform) {
    case 'espn':
      return {
        swid: (req.headers['x-espn-swid'] || '').trim(),
        s2:   (req.headers['x-espn-s2']   || '').trim(),
      };
    case 'sleeper':
    case 'yahoo':
    case 'mfl':
      return { token: (req.headers.authorization || '').replace(/^Bearer\s+/i, '') };
    default:
      return {};
  }
}

router.get('/:platform/leagues', async (req, res) => {
  try {
    const platform = String(req.params.platform || '').toLowerCase();
    const season   = String(req.query.season || '').trim();
    const adapter  = getAdapter(platform);
    const auth     = readAuth(platform, req);

    const leagues = await adapter.leagues({ season, auth });
    res.json({ ok:true, platform, season, count:leagues.length, leagues });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message });
  }
});

router.get('/:platform/teams', async (req, res) => {
  try {
    const platform = String(req.params.platform || '').toLowerCase();
    const season   = String(req.query.season || '').trim();
    const leagueId = String(req.query.leagueId || '').trim();
    const adapter  = getAdapter(platform);
    const auth     = readAuth(platform, req);

    const teams = await adapter.teams({ leagueId, season, auth });
    res.json({ ok:true, platform, season, leagueId, count:teams.length, teams });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message });
  }
});

router.get('/:platform/roster', async (req, res) => {
  try {
    const platform = String(req.params.platform || '').toLowerCase();
    const season   = String(req.query.season || '').trim();
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = String(req.query.teamId || '').trim();
    const week     = req.query.week ? Number(req.query.week) : undefined;
    const adapter  = getAdapter(platform);
    const auth     = readAuth(platform, req);

    const players = await adapter.roster({ leagueId, teamId, season, week, auth });
    res.json({ ok:true, platform, season, leagueId, teamId, week, count:players.length, players });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message });
  }
});

router.get('/:platform/free-agents', async (req, res) => {
  try {
    const platform = String(req.params.platform || '').toLowerCase();
    const season   = String(req.query.season || '').trim();
    const leagueId = String(req.query.leagueId || '').trim();
    const week     = req.query.week ? Number(req.query.week) : undefined;
    const adapter  = getAdapter(platform);
    const auth     = readAuth(platform, req);

    const players = await adapter.freeAgents({ leagueId, season, week, auth });
    res.json({ ok:true, platform, season, leagueId, week, count:players.length, players });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message });
  }
});

module.exports = router;
