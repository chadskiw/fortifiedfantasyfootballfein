// api/platforms/espn.js
// ESPN adapter: all the goodies you need today.

const BASE_LEAGUE = (season, leagueId) =>
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

const PLAYERS_URL = (season) =>
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players`;

function buildCookie(swid, s2) {
  const parts = [];
  if (swid) parts.push(`SWID=${swid}`);
  if (s2) parts.push(`espn_s2=${s2}`);
  return parts.join('; ');
}

async function espnGET(url, { swid, s2 } = {}) {
  const res = await fetch(url, {
    headers: {
      'cookie': buildCookie(swid, s2),
      'x-fantasy-filter': '', // harmless default; we set when needed
      'accept': 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ESPN GET failed ${res.status}: ${text || url}`);
  }
  return res.json();
}

/** ————— Public API ————— **/

/**
 * getLeagues — ESPN does not expose a clean "my leagues for season" API.
 * Common approaches:
 *  1) You already know your league IDs (best).
 *  2) Hit the fantasy "mUser" endpoints (unstable).
 *
 * Here we return an empty list with a friendly hint if not provided a list.
 * You can override this in your route layer by passing leagueIds you know.
 */
async function getLeagues({ season, swid, s2, leagueIds = [] }) {
  if (!Array.isArray(leagueIds) || leagueIds.length === 0) {
    return {
      season,
      leagues: [],
      note:
        'ESPN does not provide a stable "my leagues" API. Pass known leagueIds to enrich this response.',
    };
  }

  const leagues = [];
  for (const leagueId of leagueIds) {
    const data = await espnGET(`${BASE_LEAGUE(season, leagueId)}?view=mSettings&view=mTeam`, {
      swid, s2,
    });
    leagues.push({
      leagueId: data.id,
      leagueName: data.settings?.name || `League ${data.id}`,
      size: data.settings?.size || data.teams?.length || null,
      myTeamId: findMyTeamId(data),
      myTeamName: findMyTeamName(data),
      urls: {
        web: `https://fantasy.espn.com/football/league?leagueId=${data.id}&seasonId=${season}`,
        api: `${BASE_LEAGUE(season, leagueId)}`,
      },
    });
  }

  return { season, leagues };
}

async function getTeams({ season, leagueId, swid, s2 }) {
  const data = await espnGET(`${BASE_LEAGUE(season, leagueId)}?view=mTeam`, { swid, s2 });
  const teams = (data.teams || []).map(t => ({
    teamId: t.id,
    abbrev: t.abbrev,
    location: t.location,
    nickname: t.nickname,
    name: `${t.location} ${t.nickname}`.trim(),
    owners: t.owners || [],
    logo: t.logo || null,
    record: t.record || null,
  }));
  return { season, leagueId, teams };
}

async function getRoster({ season, leagueId, teamId, week, swid, s2 }) {
  const params = new URLSearchParams();
  if (Number.isFinite(week)) params.set('scoringPeriodId', String(week));
  const url = `${BASE_LEAGUE(season, leagueId)}?${params}&view=mRoster`;

  const data = await espnGET(url, { swid, s2 });
  const team = (data.teams || []).find(t => t.id === Number(teamId));
  if (!team) return { season, leagueId, teamId, week, players: [] };

  const entries = (team.roster?.entries || []).map(e => ({
    playerId: e.playerId,
    player: {
      id: e.playerId,
      fullName: e.playerPoolEntry?.player?.fullName,
      defaultPositionId: e.playerPoolEntry?.player?.defaultPositionId,
      proTeamId: e.playerPoolEntry?.player?.proTeamId,
    },
    lineupSlotId: e.lineupSlotId,
    acquiredDate: e.acquisitionDate,
    injuryStatus: e.playerPoolEntry?.player?.injuryStatus,
    stats: e.playerPoolEntry?.player?.stats || [],
  }));

  return { season, leagueId, teamId, week: Number(week) || undefined, players: entries };
}

async function getMatchups({ season, leagueId, week, swid, s2 }) {
  const params = new URLSearchParams({ view: 'mMatchupScore' });
  if (Number.isFinite(week)) params.set('scoringPeriodId', String(week));
  const url = `${BASE_LEAGUE(season, leagueId)}?${params.toString()}`;

  const data = await espnGET(url, { swid, s2 });
  const schedule = data.schedule || [];
  const out = schedule
    .filter(g => !Number.isFinite(week) || g.matchupPeriodId === Number(week))
    .map(g => ({
      id: g.id,
      week: g.matchupPeriodId,
      home: sideFrom(g.home),
      away: sideFrom(g.away),
      winner: g.winner, // 'HOME' | 'AWAY' | 'TIE' | 'UNDECIDED'
      status: g.status, // 'SCHEDULED' | 'IN_PROGRESS' | 'FINAL'
    }));

  return { season, leagueId, week: Number(week) || undefined, matchups: out };
}

async function getScoreboard({ season, leagueId, week, swid, s2 }) {
  const { matchups } = await getMatchups({ season, leagueId, week, swid, s2 });
  // Summarize for quick scoreboard
  const games = matchups.map(m => ({
    week: m.week,
    homeTeamId: m.home.teamId,
    awayTeamId: m.away.teamId,
    homePoints: m.home.totalPoints,
    awayPoints: m.away.totalPoints,
    status: m.status,
    winner: m.winner,
  }));
  return { season, leagueId, week: Number(week) || undefined, games };
}

async function getFreeAgents({ season, leagueId, week, swid, s2, limit = 100 }) {
  // ESPN free agents are fetched from the /players endpoint with JSON filter.
  // Filter for FREEAGENT + current week scoring, order by ownership descending.
  const filter = {
    players: {
      filterStatus: { value: ['FREEAGENT'] },
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
      filterRanksForScoringPeriodIds: { value: [Number(week) || 1] },
      filterActive: { value: true },
      limit,
    },
  };

  const url = `${PLAYERS_URL(season)}?scoringPeriodId=${Number(week) || 1}&view=kona_player_info`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'cookie': buildCookie(swid, s2),
      'x-fantasy-filter': JSON.stringify(filter),
      'accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ESPN Free Agents failed ${res.status}: ${text || url}`);
  }
  const json = await res.json();

  const players = (json || []).map(p => ({
    id: p.id,
    fullName: p.fullName,
    defaultPositionId: p.defaultPositionId,
    proTeamId: p.proTeamId,
    percentOwned: p.ownership?.percentOwned,
    percentStarted: p.ownership?.percentStarted,
    injuryStatus: p.injuryStatus,
    stats: p.stats || [],
  }));

  return { season, leagueId, week: Number(week) || undefined, count: players.length, players };
}

/** ————— helpers ————— **/

function sideFrom(side) {
  if (!side) return null;
  const totalPoints = (side.totalPoints ?? side.totalPointsLive ?? 0);
  return {
    teamId: side.teamId,
    totalPoints,
    rosterForCurrentScoringPeriod: side.rosterForCurrentScoringPeriod ?? null,
  };
}

function findMyTeamId(league) {
  const me = (league.teams || []).find(t => (t.currentLogin ?? t.primaryOwner) === true);
  return me?.id || null;
}

function findMyTeamName(league) {
  const me = (league.teams || []).find(t => (t.currentLogin ?? t.primaryOwner) === true);
  return me ? `${me.location} ${me.nickname}`.trim() : null;
}

module.exports = {
  getLeagues,
  getTeams,
  getRoster,
  getMatchups,
  getScoreboard,
  getFreeAgents,
};
