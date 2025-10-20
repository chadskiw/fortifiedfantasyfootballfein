// routes/espn/league.js
const express = require('express');
const router  = express.Router();

const { resolveEspnCredCandidates } = require('./_espnCred');
const { fetchJsonWithCred } = require('./_fetch');

// Small helper to call ESPN with a given credential
async function espnGET(url, cand) {
  const res = await fetchJsonWithCred(url, cand);
  return res; // { ok, status, statusText, json, text }
}

router.get('/league/selftest', (_req, res) => {
  res.json({ ok:true, msg:'league router mounted' });
});

// GET /api/platforms/espn/league?season=2025&leagueId=123456[&teamId=7]
router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : undefined;

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // Resolve ESPN cookies strictly server-side (no member id from client)
    const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId });

    if (!candidates.length) {
      return res.status(401).json({ ok:false, error:'no_espn_cred' });
    }

    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
      `?view=mSettings&view=mMatchup&view=mMatchupScore&view=mTeam`;

    let data = null, last = null, used = null;
    for (const cand of candidates) {
      const r = await espnGET(url, cand);
      last = r;
      if (r.ok && r.json) { data = r.json; used = cand; break; }
      if (r.status === 401) continue; // try next candidate
    }

    if (!data) {
      const status = last?.status || 401;
      return res.status(status).json({ ok:false, error:`upstream_${status}` });
    }

    try { res.set('x-espn-cred-source', used?.source || 'unknown'); } catch {}
    return res.json({ ok:true, league: data });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

module.exports = router;
