// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');
// routes/espn/roster.js (top of handler)
const season = Number(req.query.season);
const leagueId = String(req.query.leagueId || '');
if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

const NFL_MAX_WEEK = 18;
const CURRENT_WEEK = 6;
function safeWeek(req){
  const w = Number(req.query.week);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  // very safe fallback if no param
  return CURRENT_WEEK;
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

/** Try multiple common image fields; fall back to team logo for DST, player sprite otherwise. */
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

/** Pull projections/etc from kona_player_info for a given week. */
/** Build { playerId -> projection-ish fields } from either kona_player_info OR mBoxscore. */
function buildKonaIndex(data, week){
  const idx = new Map();

  // Helper: pick best projected value for a given week
  const pickProjected = (stats) => {
    if (!Array.isArray(stats)) return null;
    // exact week projection first (statSourceId 1 = projected)
    const exact = stats.find(s => s?.statSourceId === 1 && Number(s?.scoringPeriodId) === Number(week));
    if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
    // otherwise any projected entry
    const anyProj = stats.find(s => s?.statSourceId === 1 && Number.isFinite(+s.appliedTotal));
    return anyProj ? +anyProj.appliedTotal : null;
  };

  // ---- Path 1: kona_player_info (top-level players[]) ----
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

  // ---- Path 2: mBoxscore (walk schedule -> home/away -> rosterForCurrentScoringPeriod.entries[]) ----
  const schedule = Array.isArray(data?.schedule) ? data.schedule : [];
  for (const game of schedule) {
    const sides = [];
    if (game?.home) sides.push(game.home);
    if (game?.away) sides.push(game.away);
    // Some payloads use "competitors"
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

        // Try multiple places for stats depending on shape
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


/** Convert one roster entry to your existing player shape + optional extras. */
function espnRosterEntryToPlayer(entry = {}, extras = {} ) {
  // ESPN has two common shapes: entry.playerPoolEntry.player or entry.player
  const p = entry.playerPoolEntry?.player || entry.player || entry;

  const proTeamId = Number.isFinite(+p.proTeamId) ? +p.proTeamId : null;
  const teamAbbrFromId = TEAM_ABBR[proTeamId] || null;

  const teamAbbr = p.proTeamAbbreviation || teamAbbrFromId || p.proTeam || '';
  const position = POS[p.defaultPositionId] || p.position || p.defaultPosition || (p.id < 0 ? 'DST' : '');
  const slot     = SLOT[entry.lineupSlotId] || entry.slot || 'BN';
  const isStarter = !['BE','BN','IR'].includes(String(slot).toUpperCase());

  const headshot = resolveHeadshot(p, position, teamAbbr);

  // FantasyPros id if present; otherwise leave undefined
  const fpId = p.fantasyProsId || p.fpId || p?.externalIds?.fantasyProsId || p?.externalIds?.fpid;

  // ---- NEW (non-breaking): extra projection-y fields from kona index
  const {
    proj      = null,
    rank      = null,
    opponentAbbr = null,
    defensiveRank = null,
    byeWeek   = null,
    fmv       = null,
    proTeamId: exProTeamId = proTeamId,
    teamAbbr:  exTeamAbbr  = teamAbbr
  } = extras || {};

  return {
    // === existing fields (unchanged) ===
    id: p.id || entry.playerId,
    name: p.fullName || p.displayName || p.name,
    team: teamAbbr || '',
    position,
    slot,
    isStarter,
    fpId,
    headshot,

    // === added fields (safe to ignore by existing clients) ===
    proj,
    rank,
    opponentAbbr,
    defensiveRank,
    byeWeek,
    fmv,
    proTeamId: exProTeamId,
    teamAbbr: exTeamAbbr
  };
}

async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams({
    matchupPeriodId: String(week),
    scoringPeriodId: String(week),
  });
  // IMPORTANT: add kona_player_info so we get projections like FA view
  params.append('view','mTeam');
  params.append('view','mRoster');
  params.append('view','mSettings');
  params.append('view','mBoxscore'); // <— gives projected stats

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

  // Create a fast lookup of projections/stats per player (same week)
  const konaIndex = buildKonaIndex(data, week);

  const teamNameOf = (t) => `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim() || t?.name || `Team ${t?.id}`;

  if (teamId != null) {
    const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
    return {
      ok:true,
      team_name: team ? teamNameOf(team) : `Team ${teamId}`,
      players: team?.roster?.entries || [],
      konaIndex
    };
  }

  return {
    ok: true,
    konaIndex,
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
      const players = (raw.players || []).map(entry => {
        const pid = Number(entry?.player?.id || entry?.playerId || entry?.playerPoolEntry?.player?.id);
        const extras = raw.konaIndex.get(pid) || {};
        return espnRosterEntryToPlayer(entry, extras);
        });
      return res.json({ ok:true, platform:'espn', leagueId, season, week, teamId, team_name: raw.team_name, players });
    }

    const teams = (raw.teams || []).map(t => ({
      teamId: t.teamId,
      team_name: t.team_name,
      players: (t.players || []).map(entry => {
        const pid = Number(entry?.player?.id || entry?.playerId || entry?.playerPoolEntry?.player?.id);
        const extras = raw.konaIndex.get(pid) || {};
        return espnRosterEntryToPlayer(entry, extras);
      }),
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
