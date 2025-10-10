// routes/espn/free-agents.js
const express = require('express');
const router  = express.Router();
const fetch   = global.fetch || require('node-fetch');

// reuse your existing resolver
const { resolveEspnCredCandidates } = require('./espnCred');

// infer the public origin to hit your worker (falls back to same origin)
function inferPublicOrigin(req) {
  const h = req.headers || {};
  // honor CF-Connecting host if present, otherwise your public site
  const host = h['x-forwarded-host'] || h.host || 'fortifiedfantasy.com';
  const proto = (h['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

router.get('/free-agents', async (req, res) => {
  try {
    const {
      season, leagueId, week,
      pos, minProj, status, slotIds,
      onlyEligible, pfmv, host, diag
    } = req.query;

    if (!season || !leagueId || !week) {
      return res.status(400).json({ ok:false, error:'missing_params', need:['season','leagueId','week'] });
    }

    // best server-side creds (never expose to FE)
    const [best] = await resolveEspnCredCandidates({
      req,
      leagueId: String(leagueId),
      teamId:   req.query.teamId ? String(req.query.teamId) : null
    });

    // build target worker URL (your CF Worker function path)
    const origin = inferPublicOrigin(req);
    const u = new URL('/functions/api/free-agents', origin);
    u.searchParams.set('season', String(season));
    u.searchParams.set('leagueId', String(leagueId));
    u.searchParams.set('week', String(week));
    if (pos)         u.searchParams.set('pos', String(pos));
    if (minProj)     u.searchParams.set('minProj', String(minProj));
    if (status)      u.searchParams.set('status', String(status));
    if (slotIds)     u.searchParams.set('slotIds', String(slotIds));
    if (onlyEligible !== undefined) u.searchParams.set('onlyEligible', String(onlyEligible));
    if (pfmv !== undefined)         u.searchParams.set('pfmv', String(pfmv));
    if (host)        u.searchParams.set('host', String(host));
    if (diag)        u.searchParams.set('diag', String(diag)); // optional debug

    // server-side fetch with creds
    const headers = {
      accept: 'application/json',
      ...(best?.swid ? { 'X-ESPN-SWID': best.swid } : {}),
      ...(best?.s2   ? { 'X-ESPN-S2':   best.s2   } : {}),
      'User-Agent': req.get('user-agent') || 'FortifiedFantasy/espn-proxy'
    };

    const r = await fetch(u.toString(), { headers, redirect: 'follow' });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok:false, error:'bad_json', text }; }

    res.set('Cache-Control', 'no-store');
    return res.status(r.status).json(data);
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    return res.status(500).json({ ok:false, error:'free_agents_proxy_failed', detail: String(err?.message || err) });
  }
});

module.exports = router;
