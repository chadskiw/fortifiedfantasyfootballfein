// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');

/* -------------------- config/safe week -------------------- */
const NFL_MAX_WEEK = 18;
const CURRENT_WEEK = 7;
function safeWeek(req){
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp ?? req.query.w;
  const w = Number(raw);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  return CURRENT_WEEK;
}

/* -------------------- maps/helpers -------------------- */
const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};
const POS = { 1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST' };
const SLOT = {
  0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',
  23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'
};

function resolveHeadshot(p, position, teamAbbr){
  const cand = p?.headshot?.href || p?.headshot || p?.image?.href || p?.photo?.href || p?.avatar?.href || null;
  if (cand) return String(cand);
  if (position === 'DST' && teamAbbr) {
    const slug = teamAbbr.toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }
  if (p?.id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  return '/img/placeholders/player.png';
}

/* ------------ projection index (kona/boxscore) ------------ */
// Same approach you were using; this builds {playerId -> {proj, teamAbbr, ...}}
function buildKonaIndex(data, week){
  const idx = new Map();
  const pickProjected = (stats) => {
    if (!Array.isArray(stats)) return null;
    const exact = stats.find(s => s?.statSourceId === 1 && Number(s?.scoringPeriodId) === Number(week));
    if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
    const anyProj = stats.find(s => s?.statSourceId === 1 && Number.isFinite(+s.appliedTotal));
    return anyProj ? +anyProj.appliedTotal : null;
  };

  // Path 1: kona_player_info
  if (Array.isArray(data?.players) && data.players.length) {
    for (const p of data.players) {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) continue;
      const proTeamId = Number.isFinite(+p.proTeamId) ? +p.proTeamId : null;
      const teamAbbr  = p.proTeamAbbreviation || TEAM_ABBR[proTeamId] || null;
      const proj = pickProjected(p.stats);
      idx.set(pid, {
        proj: proj ?? null,
        rank: null,
        opponentAbbr: null,
        defensiveRank: null,
        byeWeek: null,
        fmv: null,
        proTeamId,
        teamAbbr
      });
    }
    return idx;
  }

  // Path 2: boxscore schedule walk
  const schedule = Array.isArray(data?.schedule) ? data.schedule : [];
  for (const game of schedule) {
    const sides = [];
    if (game?.home) sides.push(game.home);
    if (game?.away) sides.push(game.away);
    if (Array.isArray(game?.competitors)) sides.push(...game.competitors);

    for (const side of sides) {
      const entries = side?.rosterForCurrentScoringPeriod?.entries
                   || side?.roster?.entries
                   || [];
      for (const e of entries) {
        const p = e.playerPoolEntry?.player || e.player || {};
        const pid = Number(p?.id || e?.playerId);
        if (!Number.isFinite(pid) || idx.has(pid)) continue;

        const proTeamId = Number.isFinite(+p.proTeamId) ? +p.proTeamId : null;
        const teamAbbr  = p.proTeamAbbreviation || TEAM_ABBR[proTeamId] || null;
        const stats = Array.isArray(p?.stats) ? p.stats
                    : Array.isArray(e?.playerStats) ? e.playerStats
                    : null;
        const proj = pickProjected(stats);

        idx.set(pid, {
          proj: proj ?? null,
          rank: null,
          opponentAbbr: null,
          defensiveRank: null,
          byeWeek: null,
          fmv: null,
          proTeamId,
          teamAbbr
        });
      }
    }
  }
  return idx;
}

/* -------------- canonical player (FA-style) -------------- */
// Mirrors your FA canonicalizer (adds a `team` object while keeping legacy fields).
function toCanonicalPlayer({
  id, name, position, proTeamId, teamAbbr,
  proj, rank, opponentAbbr, defensiveRank, byeWeek, fmv,
  slot, isStarter, headshot, fpId,
  teamMeta
}) {
  return {
    // legacy/roster fields you already return
    id,
    name,
    team: teamAbbr || '',
    position,
    slot,
    isStarter,
    fpId,
    headshot,

    // FA-style analytics
    proj: (proj == null || isNaN(+proj)) ? null : Number(proj),
    rank: (rank == null || isNaN(+rank)) ? null : Number(rank),
    opponentAbbr: opponentAbbr ?? null,
    defensiveRank: (defensiveRank == null || isNaN(+defensiveRank)) ? null : Number(defensiveRank),
    byeWeek: (byeWeek == null || isNaN(+byeWeek)) ? null : Number(byeWeek),
    fmv: (fmv == null || isNaN(+fmv)) ? null : Number(fmv),
    proTeamId: (proTeamId == null || isNaN(+proTeamId)) ? null : Number(proTeamId),
    teamAbbr: teamAbbr ?? null,

    // NEW: ownership object, matching free-agents-with-team
    team: teamMeta || { type:'TEAM', teamId: null, team_name: null }
  };
}

/* -------------- ESPN fetch + transform -------------- */
async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week),
    scoringPeriodId: String(week),
  });
  // include views that expose projections (same as FA path does indirectly)
  params.append('view','mTeam');
  params.append('view','mRoster');
  params.append('view','mSettings');
  params.append('view','mBoxscore'); // projections source

  const url = `${base}?${params.toString()}`;

  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, debug });
  let data = null, last = null;

  for (const cand of cands.length ? cands : [{}]) {
    const res = await fetchJsonWithCred(url, cand);
    if (res.ok && res.json) {
      try { req.res?.set?.('x-espn-cred-source', cand.source || 'anonymous'); } catch {}
      data = res.json;
      break;
    }
    last = res;
  }

  if (!data) {
    const status = last?.status || 500;
    const text   = (last?.text || '').slice(0, 240);
    const err    = status >= 500 ? 'upstream_5xx' : (status === 401 ? 'unauthorized' : 'upstream_error');
    const e = new Error(err);
    e.meta = { status, text, url };
    throw e;
  }

  const konaIndex = buildKonaIndex(data, week);

  const teamNameOf = (t) =>
    `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim()
    || t?.name || `Team ${t?.id}`;

  if (teamId != null) {
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    return {
      ok:true,
      teamId: teamId,
      team_name: team ? teamNameOf(team) : `Team ${teamId}`,
      entries: team?.roster?.entries || [],
      konaIndex
    };
  }

  return {
    ok: true,
    konaIndex,
    teams: (data?.teams || []).map(t => ({
      teamId: t?.id,
      team_name: teamNameOf(t),
      entries: t?.roster?.entries || []
    }))
  };
}

/* -------------------- Routes -------------------- */
router.get('/roster/selftest', (_req, res) => res.json({ ok:true, msg:'roster router mounted' }));

// routes/espn/roster.js
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = (req.query.leagueId || '').trim();
    const teamId   = Number(req.query.teamId);
    const rawWeek  = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp ?? req.query.w;
    const week     = (() => {
      const n = Number(rawWeek);
      if (Number.isFinite(n) && n >= 1 && n <= 18) return n;
      return CURRENT_WEEK; // whatever you set for in-season default
    })();

    if (!Number.isFinite(season) || !leagueId || !Number.isFinite(teamId)) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId });
    if (!candidates.length) {
      return res.status(401).json({ ok:false, error:'no_espn_cred' });
    }

    const url =
      `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
      `?scoringPeriodId=${week}&matchupPeriodId=${week}&forTeamId=${teamId}&view=mRoster&view=mBoxscore`;

    const data = await fetchJsonWithCred(url, candidates);
    // ...normalize to your shape...
    return res.json({ ok:true, players: normalizeRoster(data, week) });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});


module.exports = router;
