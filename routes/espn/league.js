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
// routes/espn/roster.js (core fetch bit)
import { resolveLeagueCred } from './_espnCred.js';

export async function getRoster(req, res, db){
  const season   = String(req.query.season || new Date().getUTCFullYear());
  const leagueId = String(req.query.leagueId || '');
  const teamId   = req.query.teamId ? String(req.query.teamId) : null;
  const scope    = (req.query.scope === 'season') ? 'season' : 'week';
  const week     = req.query.week ? String(req.query.week) : null;

  if (!leagueId) return res.status(400).json({ ok:false, error:'leagueId required' });

  const viewerMemberId = req.user?.member_id || null;
  const cred = await resolveLeagueCred(db, { leagueId, viewerMemberId });

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const qs   = new URLSearchParams();
  qs.set('view','mRoster');
  if (scope === 'week' && week) qs.set('scoringPeriodId', week);

  const url = `${base}?${qs.toString()}`;
  const cookie = cred.espn_s2 ? `espn_s2=${cred.espn_s2}; SWID=${cred.swid}` : '';

  let r = await fetch(url, { headers: { 'User-Agent': 'ff-platform-service/1.0', ...(cookie ? { cookie } : {}) } });
  if (r.status === 401) r = await fetch(url, { headers: { 'User-Agent': 'ff-platform-service/1.0' } }); // public fallback

  if (!r.ok) return res.status(r.status).json({ ok:false, status:r.status, error:'ESPN roster fetch failed' });

  const j = await r.json();

  // Optional: narrow to teamId if provided
  const teams = Array.isArray(j?.teams) ? j.teams : [];
  const subset = teamId ? teams.filter(t => String(t?.id) === teamId) : teams;

  return res.json({ ok:true, data: subset });
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
