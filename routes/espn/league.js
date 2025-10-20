const express = require('express');
const router  = express.Router();

const { resolveEspnCredCandidates } = require('./_espnCred');

// Try to use shared helper if present; else do a local fetch with cookie header.
let fetchJsonWithCred = null;
try { ({ fetchJsonWithCred } = require('./_fetch')); } catch {}

async function espnGET(url, cand) {
  if (fetchJsonWithCred) {
    // Most robust path: your shared helper may already rotate through candidates.
    const r = await fetchJsonWithCred(url, cand);
    return r; // expect { ok, status, json? }
  }
  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    // This cookie is the ONLY thing ESPN needs for private leagues
    cookie: `espn_s2=${cand.s2}; SWID=${cand.swid};`,
    'x-fantasy-platform': 'web',
    'x-fantasy-source': 'kona',
  };
  const resp = await fetch(url, { headers });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

// GET /api/platforms/espn/league?season=2025&leagueId=123456[&teamId=7]
router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : undefined;

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId });
    if (!candidates.length) return res.status(401).json({ ok:false, error:'no_espn_cred' });

    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
      `?view=mSettings&view=mMatchup&view=mMatchupScore&view=mTeam`;

    let used = null, data = null, lastStatus = 0;
    for (const cand of candidates) {
      const r = await espnGET(url, cand);
      lastStatus = r.status || 0;
      if (r.ok && r.json) { used = cand; data = r.json; break; }
      if (r.status === 401) continue;
    }
    if (!data) return res.status(lastStatus || 401).json({ ok:false, error: `upstream_${lastStatus||'error'}` });

    try { res.set('x-espn-cred-source', used?.source || 'unknown'); } catch {}
    return res.json({ ok:true, league: data });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
