// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

const NFL_MAX_WEEK = 18;
const DEFAULT_WEEK = Number(process.env.CURRENT_WEEK || 7);
const safeWeek = (req) => {
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp;
  const w = Number(raw);
  return Number.isFinite(w) && w>=1 ? Math.min(w, NFL_MAX_WEEK) : DEFAULT_WEEK;
};

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

// (keep your TEAM_ABBR / POS / SLOT / headshot / pickProjected / pickActual helpers the same)
const TEAM_ABBR = {1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'};
const POS = {1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST'};
const SLOT={0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'};
const headshotFor=(p,pos,abbr)=>p?.headshot?.href||p?.image?.href||p?.photo?.href|| (pos==='DST'&&abbr?`https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png&h=80&w=80&scale=crop`: (p?.id?`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`:'/img/placeholders/player.png'));
const pickProjected=(stats,week)=>{if(!Array.isArray(stats))return null;const ex=stats.find(s=>s?.statSourceId===1&&+s?.scoringPeriodId===+week);if(ex&&Number.isFinite(+ex.appliedTotal))return +ex.appliedTotal;const any=stats.find(s=>s?.statSourceId===1&&Number.isFinite(+s.appliedTotal));return any?+any.appliedTotal:null;};
const pickActual=(stats,week)=>{if(!Array.isArray(stats))return null;const ex=stats.find(s=>s?.statSourceId===0&&+s?.scoringPeriodId===+week);if(ex&&Number.isFinite(+ex.appliedTotal))return +ex.appliedTotal;const any=stats.find(s=>s?.statSourceId===0&&Number.isFinite(+s.appliedTotal));return any?+any.appliedTotal:null;};
const teamNameOf=t=>`${t?.location||t?.teamLocation||''} ${t?.nickname||t?.teamNickname||''}`.trim()||t?.name||`Team ${t?.id}`;

router.get('/roster', async (req, res) => {
  try{
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId||'').trim();
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : null;
    const week     = safeWeek(req);
    if (!Number.isFinite(season) || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId });
    if (!cands.length) return res.status(401).json({ ok:false, error:'no_espn_cred' });

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams({ scoringPeriodId:String(week), matchupPeriodId:String(week) });
    params.append('view','mTeam'); params.append('view','mRoster'); params.append('view','mSettings'); params.append('view','mBoxscore');
    const url = `${base}?${params.toString()}`;

    let used=null, data=null, last=null;
    for (const cand of cands) {
      const r = await espnGET(url, cand);
      last = r;
      if (r.ok && r.json) { used=cand; data=r.json; break; }
      if (r.status !== 401) break;
    }
    if (!data) {
      if (last?.status === 401) {
        const first = cands[0];
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
    } catch {}

    if (teamId != null && Number.isFinite(teamId)) {
      const t = (data?.teams || []).find(x => Number(x?.id) === Number(teamId));
      const entries = t?.roster?.entries || [];
      const players = entries.map(e => {
        const slotId = Number(e?.lineupSlotId);
        const slot = SLOT[slotId] || 'BN';
        const isStarter = ![20,21].includes(slotId) && slot!=='BN' && slot!=='IR';
        const p = e?.playerPoolEntry?.player || e.player || {};
        const pos = POS[p?.defaultPositionId] || p?.defaultPosition || '';
        const abbr = p?.proTeamAbbreviation || (p?.proTeamId ? TEAM_ABBR[p.proTeamId] : null);
        return {
          slot, isStarter,
          name: p?.fullName || [p?.firstName,p?.lastName].filter(Boolean).join(' ') || p?.name || '',
          position: pos,
          teamAbbr: abbr || '',
          proj: (()=>{const v=pickProjected(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
          points: (()=>{const v=pickActual(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
          appliedPoints: (()=>{const v=pickActual(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
          headshot: headshotFor(p, pos, abbr)
        };
      });
      return res.json({ ok:true, platform:'espn', leagueId, season, week, teamId, team_name: t ? teamNameOf(t) : `Team ${teamId}`, players });
    }

    const teams = (data?.teams || []).map(t => {
      const entries = t?.roster?.entries || [];
      return {
        teamId: t.id,
        team_name: teamNameOf(t),
        players: entries.map(e => {
          const slotId = Number(e?.lineupSlotId);
          const slot = SLOT[slotId] || 'BN';
          const isStarter = ![20,21].includes(slotId) && slot!=='BN' && slot!=='IR';
          const p = e?.playerPoolEntry?.player || e.player || {};
          const pos = POS[p?.defaultPositionId] || p?.defaultPosition || '';
          const abbr = p?.proTeamAbbreviation || (p?.proTeamId ? TEAM_ABBR[p.proTeamId] : null);
          return {
            slot, isStarter,
            name: p?.fullName || [p?.firstName,p?.lastName].filter(Boolean).join(' ') || p?.name || '',
            position: pos,
            teamAbbr: abbr || '',
            proj: (()=>{const v=pickProjected(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
            points: (()=>{const v=pickActual(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
            appliedPoints: (()=>{const v=pickActual(p?.stats||e?.playerStats, week);return v==null?null:Number(v);})(),
            headshot: headshotFor(p, pos, abbr)
          };
        })
      };
    });

    return res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

module.exports = router;
