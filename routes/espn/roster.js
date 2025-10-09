// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');

const NFL_MAX_WEEK = 18;

function safeWeek(req){
  const w = Number(req.query.week);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  // very safe fallback if no param
  return 1;
}

function resolveHeadshot(p, position, teamAbbr){
  const cand = p?.headshot?.href || p?.headshot || p?.image?.href || p?.photo?.href || p?.avatar?.href || null;
  if (cand) return cand;
  if (position === 'DST' && teamAbbr) {
    const slug = String(teamAbbr).toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }
  if (p?.id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  return '/img/placeholders/player.png';
}

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
  const cand = p?.headshot?.href || p?.headshot || p?.image?.href || p?.photo?.href || p?.avatar?.href;
  if (cand) return String(cand);
  if (position === 'DST' && teamAbbr) {
    const slug = teamAbbr.toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }
  if (p?.id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  return '/img/placeholders/player.png';
}

function espnRosterEntryToPlayer(entry = {}) {
  // ESPN has two common shapes: entry.playerPoolEntry.player or entry.player
  const p = entry.playerPoolEntry?.player || entry.player || entry;

  const teamAbbr = p.proTeamAbbreviation || TEAM_ABBR[p.proTeamId] || p.proTeam || '';
  const position = POS[p.defaultPositionId] || p.position || p.defaultPosition || (p.id < 0 ? 'DST' : '');
  const slot     = SLOT[entry.lineupSlotId] || entry.slot || 'BN';
  const isStarter = !['BE','BN','IR'].includes(String(slot).toUpperCase());

  const headshot = resolveHeadshot(p, position, teamAbbr);

  // FantasyPros id if present; otherwise leave undefined
  const fpId = p.fantasyProsId || p.fpId || p?.externalIds?.fantasyProsId || p?.externalIds?.fpid;

  return {
    id: p.id || entry.playerId,
    name: p.fullName || p.displayName || p.name,
    team: teamAbbr || '',
    position,
    slot,
    isStarter,
    fpId,
    headshot
  };
}


async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week),
    scoringPeriodId: String(week),
  });
  params.append('view','mTeam');
  params.append('view','mRoster');
  params.append('view','mSettings');
  const url = `${base}?${params.toString()}`;

  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, debug });
  let data = null;
  let last = null;

  for (const cand of cands.length ? cands : [{}]) { // allow anonymous
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

  const teamNameOf = (t) => `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim() || t?.name || `Team ${t?.id}`;

  if (teamId != null) {
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    return { ok:true, team_name: team ? teamNameOf(team) : `Team ${teamId}`, players: team?.roster?.entries || [] };
  }

  return {
    ok: true,
    teams: (data?.teams || []).map(t => ({
      teamId: t?.id,
      team_name: teamNameOf(t),
      players: t?.roster?.entries || []
    }))
  };
}

// quick mount test
router.get('/roster/selftest', (_req, res) => res.json({ ok:true, msg:'roster router mounted' }));

router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : null;
    const week     = safeWeek(req);

    const raw = await getRosterFromUpstream({ season, leagueId, week, teamId, req });

    if (teamId != null) {
      const players = (raw.players || []).map(espnRosterEntryToPlayer);
      return res.json({ ok:true, platform:'espn', leagueId, season, week, teamId, team_name: raw.team_name, players });
    }

    const teams = (raw.teams || []).map(t => ({
      teamId: t.teamId,
      team_name: t.team_name,
      players: (t.players || []).map(espnRosterEntryToPlayer),
    }));
    res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
  } catch (err) {
    const status = err?.meta?.status >= 500 ? 502 : 500;
    res.status(status).json({
      ok: false,
      error: err.message || 'server_error',
      status: err?.meta?.status || status,
      detail: err?.meta?.text || undefined
    });
  }
});

module.exports = router;
