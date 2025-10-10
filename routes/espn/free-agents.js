// routes/espn/free-agents.js
const express = require('express');
const router  = express.Router();
const fetch   = global.fetch || require('node-fetch');

// reuse your existing resolver
const { fetchFromEspnWithCandidates } = require('./espnCred');

// at top, near other consts
const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';

// builds the CF Pages Function URL you already host
function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyElig }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  if (pos) u.searchParams.set('pos', String(pos));
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyElig));
  return u;
}

// GET /api/platforms/espn/free-agents
router.get('/free-agents', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = Number(req.query.week || 1);
    const pos      = String(req.query.pos || 'ALL');
    const minProj  = Number(req.query.minProj || 2);
    const onlyElig = String(req.query.onlyEligible || 'true') === 'true';

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const upstream = buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyElig });

    // Use your server-side cred resolution (same path used by /league, /roster)
    const { status, body } = await fetchFromEspnWithCandidates(
      upstream.toString(),
      { headers: {} }, // we don't forward browser cookies
      { leagueId, teamId: null, memberId: null }
    );

    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Cache-Control', 'no-store, private');

    if (status >= 200 && status < 300) {
      const data = JSON.parse(body || '{}');
      return res.json({ ok:true, ...data });
    }
    return res.status(200).json({ ok:false, error:String(body||'upstream_error'), upstream: upstream.toString() });
  } catch (e) {
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});


module.exports = router;
