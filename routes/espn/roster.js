const express = require('express');
const router  = express.Router();

const { resolveEspnCredCandidates } = require('./_espnCred');

let fetchJsonWithCred = null;
try { ({ fetchJsonWithCred } = require('./_fetch')); } catch {}

async function espnGET(url, cand) {
  if (fetchJsonWithCred) return fetchJsonWithCred(url, cand);
  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    cookie: `espn_s2=${cand.s2}; SWID=${cand.swid};`,
    'x-fantasy-platform': 'web',
    'x-fantasy-source': 'kona',
  };
  const resp = await fetch(url, { headers });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- config/safe week -------------------- */
const NFL_MAX_WEEK = 18;
const CURRENT_WEEK = 7; // adjust if you track this elsewhere

function safeWeek(req){
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp ?? req.query.w;
  const w = Number(raw);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  return CURRENT_WEEK;
}

/* -------------------- normalize helpers -------------------- */
const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};
const POS   = { 1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST' };
const SLOT  = { 0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX' };

const headshotFor = (p, position, teamAbbr) => {
  const cand = p?.headshot?.href || p?.headshot || p?.image?.href || p?.photo?.href || p?.avatar?.href || null;
  if (cand) return String(cand);
  if (position === 'DST' && teamAbbr) {
    const slug = teamAbbr.toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }
  if (p?.id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  return '/img/placeholders/player.png';
};
const pickProjected = (stats, week) => {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => s?.statSourceId === 1 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const anyProj = stats.find(s => s?.statSourceId === 1 && Number.isFinite(+s.appliedTotal));
  return anyProj ? +anyProj.appliedTotal : null;
};
const pickActual = (stats, week) => {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => s?.statSourceId === 0 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const anyAct = stats.find(s => s?.statSourceId === 0 && Number.isFinite(+s.appliedTotal));
  return anyAct ? +anyAct.appliedTotal : null;
};

/* -------------------- route -------------------- */

// GET /api/platforms/espn/roster?season=2025&leagueId=1634950747&teamId=7&week=7
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = Number(req.query.teamId);
    const week     = safeWeek(req);

    if (!Number.isFinite(season) || !leagueId || !Number.isFinite(teamId)) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId });
    if (!candidates.length) return res.status(401).json({ ok:false, error:'no_espn_cred' });

    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
      `?forTeamId=${teamId}&scoringPeriodId=${week}&matchupPeriodId=${week}&view=mTeam&view=mRoster&view=mSettings&view=mBoxscore`;

    let used = null, data = null, lastStatus = 0;
    for (const cand of candidates) {
      const r = await espnGET(url, cand);
      lastStatus = r.status || 0;
      if (r.ok && r.json) { used = cand; data = r.json; break; }
      if (r.status === 401) continue;
    }
    if (!data) return res.status(lastStatus || 401).json({ ok:false, error:`upstream_${lastStatus||'error'}` });

    // Normalize to what your FE expects
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    const entries = team?.roster?.entries || [];
    const players = entries.map(e => {
      const slotId = Number(e?.lineupSlotId);
      const slot   = SLOT[slotId] || 'BN';
      const isStarter = ![20,21].includes(slotId) && slot !== 'BN' && slot !== 'IR';
      const p = e?.playerPoolEntry?.player || e.player || {};
      const pid = Number(p?.id);
      const position = POS[p?.defaultPositionId] || p?.defaultPosition || '';
      const proTeamId = Number.isFinite(+p?.proTeamId) ? +p.proTeamId : null;
      const teamAbbr  = p?.proTeamAbbreviation || (proTeamId ? TEAM_ABBR[proTeamId] : null);
      const proj = pickProjected(p?.stats || e?.playerStats, week);
      const pts  = pickActual(p?.stats || e?.playerStats, week);
      return {
        slot, isStarter,
        name: p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.name || '',
        position, teamAbbr: teamAbbr || '',
        proj: proj == null ? null : Number(proj),
        points: pts == null ? null : Number(pts),
        appliedPoints: pts == null ? null : Number(pts),
        headshot: headshotFor(p, position, teamAbbr)
      };
    });

    try { res.set('x-espn-cred-source', used?.source || 'unknown'); } catch {}
    return res.json({ ok:true, players });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
