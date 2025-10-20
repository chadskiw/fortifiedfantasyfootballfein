// routes/espn/league.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

// Single ESPN fetch with optional cookie for a candidate
async function espnGET(url, cand) {
  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    accept: 'application/json',
    'user-agent': 'ff-platform-service/1.0',
    'x-fantasy-platform': 'web',
    'x-fantasy-source': 'kona',
  };
  const cookie = (cand && cand.s2 && cand.swid) ? `espn_s2=${cand.s2}; SWID=${cand.swid};` : '';
  const resp = await fetch(url, cookie ? { headers: { ...headers, cookie } } : { headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, json, text };
}

router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season || new Date().getUTCFullYear());
    const leagueId = String(req.query.leagueId || '').trim();

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error: 'missing_params' });
    }

    // ESPN league endpoint: team list + settings
    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams();
    params.append('view','mTeam');
    params.append('view','mSettings');
    const url = `${base}?${params.toString()}`;

    // Resolve candidate creds (server-side only)
    const cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId: null });

    let used = null;
    let last = null;
    let data = null;

    if (Array.isArray(cands) && cands.length) {
      for (const cand of cands) {
        const r = await espnGET(url, cand);
        last = r;
        if (r.ok && r.json) { used = cand; data = r.json; break; }
        if (r.status !== 401) break; // for non-auth errors, stop trying others
      }
    }

    // Public fallback for leagues that don’t need cookies
    if (!data) {
      const rPub = await espnGET(url, null);
      last = rPub;
      if (rPub.ok && rPub.json) {
        data = rPub.json;
        used = null; // mark as public
      }
    }

    // Still nothing? Surface a useful error
    if (!data) {
      if (last?.status === 401 && cands?.length) {
        const first = cands[0];
        return res.status(401).json({
          ok: false,
          error: first?.stale ? 'espn_cred_stale' : 'espn_not_visible',
          hint:  first?.stale ? 'Please re-link ESPN (cookie expired)' : 'Creds exist but do not have access to this league',
        });
      }
      return res.status(last?.status || 500).json({
        ok: false,
        error: 'upstream_error',
        detail: (last?.text || '').slice(0, 240),
      });
    }

    // Helpful headers for diagnostics
    try {
      res.set('x-espn-cred-source', used?.source || 'public');
      res.set('x-espn-cred-stale', used?.stale ? '1' : '0');
      if (used?.swid) res.set('x-ff-cred-swid', String(used.swid).slice(0, 12) + '…');
    } catch {}

    // Return full league JSON plus a top-level teams shim for FE convenience
    const teams = Array.isArray(data?.teams) ? data.teams : [];
    return res.json({ ok: true, league: data, teams });

  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
