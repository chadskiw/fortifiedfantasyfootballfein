// routes/espn/league.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

let fetchJsonWithCred = null;
try { ({ fetchJsonWithCred } = require('./_fetch')); } catch {}

async function espnGET(url, cand) {
  if (fetchJsonWithCred) return fetchJsonWithCred(url, cand);
  const fetch = global.fetch || (await import('node-fetch')).default;
  const resp = await fetch(url, {
    headers: {
      cookie: `espn_s2=${cand.s2}; SWID=${cand.swid};`,
      'x-fantasy-platform': 'web', 'x-fantasy-source': 'kona'
    }
  });
  const json = await resp.json().catch(()=>null);
  return { ok: resp.ok, status: resp.status, json };
}

// GET /api/platforms/espn/league?season=2025&leagueId=1888700373[&teamId=4]
router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : undefined;

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const cands = await resolveEspnCredCandidates({ req, leagueId, teamId });
    if (!cands.length) return res.status(401).json({ ok:false, error:'no_espn_cred' });

    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
      `?view=mSettings&view=mMatchup&view=mMatchupScore&view=mTeam`;

    let used=null, data=null, last=0;
    for (const cand of cands) {
      const r = await espnGET(url, cand);
      last = r.status || 0;
      if (r.ok && r.json) { used=cand; data=r.json; break; }
      if (r.status === 401) continue;
    }
    if (!data) return res.status(last||401).json({ ok:false, error:`upstream_${last||'error'}` });

    try {
      res.set('x-espn-cred-source', used?.source || 'unknown');
      if (used?.memberId) res.set('x-ff-cred-member', String(used.memberId));
      res.set('x-ff-cred-swid', (used?.swid||'').slice(0,10)+'…');
    } catch {}

    return res.json({ ok:true, league: data });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

module.exports = router;
