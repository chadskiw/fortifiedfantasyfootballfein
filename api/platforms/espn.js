// TRUE_LOCATION: api/platforms/espn.js
// IN_USE: TRUE
// server/routes/platforms-espn.js
const express = require('express');
const cookieParser = require('cookie-parser');
const router = express.Router();
router.use(cookieParser());
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const espn = require('../../src/api/platforms/espn');

// read creds from cookies or fallback headers
function readEspnCreds(req) {
  const swid = req.cookies?.SWID || req.get('x-espn-swid') || null;
  const s2   = req.cookies?.espn_s2 || req.cookies?.ESPN_S2 || req.get('x-espn-s2') || null;
  return { swid, s2 };
}

router.get('/authcheck', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  const has = !!(swid && s2);
  res.json({ ok: has, authed: has });
});

router.get('/leagues', async (req, res) => {
  try {
    const season = Number(req.query.season);
    if (!season) return res.status(400).json({ ok:false, error:'season required' });

    // leagueId can be repeated or comma-separated
    const ids = []
      .concat(req.query.leagueId || req.query.leagueIds || [])
      .flatMap(v => String(v).split(',').map(s => s.trim()).filter(Boolean));

    const { swid, s2 } = readEspnCreds(req);
    const username = req.query.username || null;
    const data = await espn.getLeagues({ season, leagueIds: ids, swid, s2, username });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

router.get('/teams', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'season & leagueId required' });
    const { swid, s2 } = readEspnCreds(req);
    const data = await espn.getTeams({ season, leagueId, swid, s2 });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

router.get('/roster', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const teamId = String(req.query.teamId || '');
    const week = req.query.week != null ? Number(req.query.week) : undefined;
    if (!season || !leagueId || !teamId) return res.status(400).json({ ok:false, error:'season, leagueId, teamId required' });

    const { swid, s2 } = readEspnCreds(req);
    const data = await espn.getRoster({ season, leagueId, teamId, week, swid, s2 });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

router.get('/matchups', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week = req.query.week != null ? Number(req.query.week) : undefined;
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'season & leagueId required' });

    const { swid, s2 } = readEspnCreds(req);
    const data = await espn.getMatchups({ season, leagueId, week, swid, s2 });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

router.get('/scoreboard', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week = req.query.week != null ? Number(req.query.week) : undefined;
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'season & leagueId required' });

    const { swid, s2 } = readEspnCreds(req);
    const data = await espn.getScoreboard({ season, leagueId, week, swid, s2 });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

router.get('/free-agents', async (req, res) => {
  try {
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week = req.query.week != null ? Number(req.query.week) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : 100;
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'season & leagueId required' });

    const { swid, s2 } = readEspnCreds(req);
    const data = await espn.getFreeAgents({ season, leagueId, week, swid, s2, limit });
    res.json({ ok:true, ...data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});
function requireEspnCreds(req, res, next) {
  if (extractEspnCreds(req)) return next();
  return res.status(401).json({ ok:false, error:'no_espn_creds' });
}
module.exports = router;
