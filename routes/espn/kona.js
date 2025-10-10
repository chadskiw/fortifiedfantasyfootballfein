// routes/espn/kona.js
const express = require('express');
const router = express.Router();
const fetch = global.fetch || require('node-fetch');
const { resolveEspnCredCandidates } = require('./espnCred');

function cookieFor(c) {
  const parts = [];
  if (c?.swid) parts.push(`SWID=${c.swid}`);
  if (c?.s2)   parts.push(`espn_s2=${c.s2}`);
  return parts.join('; ');
}

async function fetchJsonWithCred(url, cand) {
  const headers = {
    accept: 'application/json',
    referer: 'https://fantasy.espn.com/',
  };
  const cookie = cookieFor({ swid: cand?.swid, s2: cand?.s2 });
  if (cookie) headers.cookie = cookie;

  const r = await fetch(url, { headers });
  const text = await r.text();
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const json = (ct.includes('application/json') || /^[{\[]/.test((text||'').trim())) ? JSON.parse(text || '{}') : null;
  return { ok: r.ok, status: r.status, text, json };
}

async function pullPage({ baseUrl, params, cand, limit }) {
  const u = new URL(baseUrl);
  for (const [k,v] of params) u.searchParams.set(k, v);
  u.searchParams.set('limit', String(limit));
  const res = await fetchJsonWithCred(u.toString(), cand);
  return res;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

router.get('/kona', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const week     = Number(req.query.scoringPeriodId || req.query.week || req.query.matchupPeriodId);
    const teamId   = req.query.teamId ? String(req.query.teamId) : null;
    if (!season || !leagueId || !week) {
      return res.status(400).json({ ok:false, error:'missing_params', need:['season','leagueId','scoringPeriodId'] });
    }

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = [
      ['view','kona_player_info'],
      ['scoringPeriodId', String(week)],
    ];
    if (teamId) params.push(['teamId', teamId]);

    // Try real creds (owner, league member, request cookies), then unauth last
    const cands = await resolveEspnCredCandidates({ req, leagueId, teamId });
    if (!cands.length) cands.push({ swid:'', s2:'', source:'unauth' });

    let finalBundle = null;
    let lastErr = null;

    for (const cand of cands) {
      // pagination with fallback limits
      const limits = [200, 150, 100, 50];
      let got = null;

      for (const lim of limits) {
        let offset = 0;
        let merged = null;
        let pages = 0;

        while (true) {
          const res1 = await pullPage({ baseUrl: base, params, cand, limit: `${lim}&offset=${offset}` });
          if (res1.ok && res1.json) {
            const b = res1.json;
            if (!merged) merged = b; else {
              // merge player arrays
              merged.players = (merged.players || []).concat(b.players || []);
            }
            pages += 1;

            const gotCount = (b.players || []).length;
            if (gotCount < lim) break; // last page
            offset += lim;
            // be gentle with ESPN
            await sleep(120);
          } else if (res1.status >= 500) {
            // upstream flaky, try next smaller limit
            lastErr = res1;
            merged = null;
            break;
          } else {
            // unauthorized or other error → stop this candidate
            lastErr = res1;
            merged = null;
            break;
          }
        }

        if (merged && pages > 0) {
          got = merged;
          break;
        }
      }

      if (got) {
        finalBundle = got;
        try { res.set('x-espn-cred-source', cand.source || 'unknown'); } catch {}
        break;
      }
    }

    if (!finalBundle) {
      const status = lastErr?.status || 401;
      const errMsg = status === 401 ? 'unauthorized' : 'upstream_failed';
      return res.status(status).json({ ok:false, error:errMsg, status, preview:(lastErr?.text||'').slice(0,200) });
    }

    return res
      .status(200)
      .set('Cache-Control','no-store, private')
      .json(finalBundle);
  } catch (e) {
    console.error('[espn/kona]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
