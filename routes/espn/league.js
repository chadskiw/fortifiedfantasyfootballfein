// routes/espn/league.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

async function espnGET(url, cand) {
  const fetch = global.fetch || (await import('node-fetch')).default;
  const resp = await fetch(url, {
    headers: {
      cookie: `espn_s2=${cand.s2}; SWID=${cand.swid};`,
      'x-fantasy-platform':'web','x-fantasy-source':'kona','accept':'application/json'
    }
  });
  const text = await resp.text(); let json=null; try{ json=JSON.parse(text);}catch{}
  return { ok:resp.ok, status:resp.status, json, text };
}

router.get('/league', async (req, res) => {
  try{
    const season = Number(req.query.season);
    const leagueId = String(req.query.leagueId||'').trim();
    const teamId = req.query.teamId != null ? Number(req.query.teamId) : undefined;
    if (!Number.isFinite(season) || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId });
    if (!cands.length) return res.status(401).json({ ok:false, error:'no_espn_cred' });

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;

    let used=null, data=null, last=null;
    for (const cand of cands) {
      const r = await espnGET(url, cand);
      last = r;
      if (r.ok && r.json) { used=cand; data=r.json; break; }
      if (r.status !== 401) break; // non-auth err → stop
    }

    if (!data) {
      const first = cands[0];
      if (last?.status === 401) {
        return res.status(401).json({
          ok:false,
          error: first?.stale ? 'espn_cred_stale' : 'espn_not_visible',
          hint: first?.stale ? 'Please re-link ESPN (cookie expired)' : 'Creds exist but do not have access to this league',
        });
      }
      return res.status(last?.status||500).json({ ok:false, error:'upstream_error', detail:(last?.text||'').slice(0,240) });
    }

    try {
      res.set('x-espn-cred-source', used?.source || 'unknown');
      res.set('x-espn-cred-stale', used?.stale ? '1' : '0');
      res.set('x-ff-cred-swid', (used?.swid||'').slice(0,12)+'…');
    } catch{}

    return res.json({ ok:true, league: data });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

module.exports = router;
