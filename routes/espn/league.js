// routes/espn/league.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');

router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : undefined;
    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'season and leagueId are required' });
    }

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const url  = `${base}?view=mTeam&view=mSettings`;

    // IMPORTANT: pass season to resolver
    const cands0 = await resolveEspnCredCandidates({ req, season, leagueId, teamId, debug:false });
    const candidates = cands0.length ? cands0 : [{ source:'public', swid:'', s2:'' }];

    let used=null, data=null, last=null;
    for (const cand of candidates) {
      const r = await fetchJsonWithCred(url, cand);
      last = r;
      if (r.ok && r.json) { used=cand; data=r.json; break; }
      if (r.status === 401) {
        console.warn('[espn/league] 401 with candidate', {
          leagueId, teamId, source:cand.source, member_id:cand.memberId || null,
          bodySnippet: (r.text||'').slice(0,240)
        });
      }
    }
    if (!data) {
      const status = last?.status || 401;
      return res.status(status).json({ ok:false, error:'ESPN league fetch failed', status, detail:last?.statusText || '' });
    }

    try {
      res.set('x-espn-cred-source', used?.source || 'unknown');
      if (used?.memberId) res.set('x-ff-cred-member', String(used.memberId));
      res.set('x-ff-cred-swid', (used?.swid||'').slice(0,12)+'…');
    } catch {}

    // Minimal normalization (same as your current file)
    const teamNameOf = (t) => {
      const loc = t?.location || t?.teamLocation || '';
      const nick = t?.nickname || t?.teamNickname || '';
      const joined = `${loc} ${nick}`.trim();
      return joined || t?.name || `Team ${t?.id}`;
    };

    const teams = (data?.teams || []).map(t => ({
      teamId: t?.id,
      team_name: teamNameOf(t),
      logo: t?.logo || t?.logoUrl || t?.teamLogoUrl || null,
      wins: t?.record?.overall?.wins ?? 0,
      losses: t?.record?.overall?.losses ?? 0,
      ties: t?.record?.overall?.ties ?? 0,
    }));

    return res.json({
      ok: true,
      leagueId,
      season,
      teamCount: teams.length,
      teams,
      meta: {
        scoringPeriodId: data?.scoringPeriodId,
        status: data?.status?.type?.name,
      }
    });
  } catch (err) {
    console.error('[espn/league] error:', err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});

module.exports = router;
