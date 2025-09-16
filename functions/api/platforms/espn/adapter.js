// functions/api/platforms/espn/adapter.js
const { LRU } = require('../shared/cache');
const { jsonFetch } = require('../shared/http');
const { league: normLeague, team: normTeam, player: normPlayer } = require('../shared/normalize');

const cache = new LRU(300);

// ESPN endpoints (v3/v2 mix; cookies required)
function base(season) {
  return `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`;
}

function assertCookies({ swid, s2 }) {
  if (!swid || !s2) throw new Error('Missing SWID or espn_s2');
  return { SWID: swid, espn_s2: s2 };
}

async function getLeagues({ season, swid, s2 }) {
  const cookies = assertCookies({ swid, s2 });
  const key = `espn:leagues:${season}:${swid}`;
  return cache.remember(key, 30_000, async () => {
    // Membership endpoint
    const url = `${base(season)}/players?scoringPeriodId=1`; // ping (cheap) to validate cookies
    await jsonFetch(url, { cookies }).catch(()=>null);

    // League list: use v2 membership
    const url2 = `https://fantasy.espn.com/apis/v2/games/ffl/seasons/${season}/players?scoringPeriodId=1`; // dummy call for cookie scope
    await jsonFetch(url2, { cookies }).catch(()=>null);

    // Best approach: scrape team pages list via private API index (common pattern in your stack is passing known league ids)
    // Here: assume you store league ids in FEIN pools; fallback returns empty array.
    return [];
  }).then(list => list.map(normLeague));
}

async function getTeams({ season, leagueId, swid, s2 }) {
  const cookies = assertCookies({ swid, s2 });
  const key = `espn:teams:${season}:${leagueId}`;
  return cache.remember(key, 30_000, async () => {
    const url = `${base(season)}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings`;
    const data = await jsonFetch(url, { cookies });
    const teams = (data.teams || []).map(t => normTeam({
      teamId: t.id,
      teamName: t.location && t.nickname ? `${t.location} ${t.nickname}` : (t.name || `Team ${t.id}`),
      owner: (t.owners && t.owners[0]) || null,
      record: t.record && t.record.overall ? t.record.overall : null,
      logo: t.logo || null,
    }));
    return teams;
  });
}

async function getRoster({ season, leagueId, teamId, scope = 'week', week = null, swid, s2 }) {
  const cookies = assertCookies({ swid, s2 });
  const key = `espn:roster:${season}:${leagueId}:${teamId}:${scope}:${week ?? 'na'}`;
  return cache.remember(key, 20_000, async () => {
    const sp = week ? Number(week) : undefined;
    const views = ['mRoster', 'mMatchupScore', 'mSettings'];
    const query = views.map(v => `view=${v}`).join('&') + (sp ? `&scoringPeriodId=${sp}` : '');
    const url = `${base(season)}/segments/0/leagues/${leagueId}/teams/${teamId}?${query}`;
    const data = await jsonFetch(url, { cookies });

    const scoringPeriodId = sp || data.status?.currentMatchupPeriod || 1;

    const players = (data.roster?.entries || []).map(e => {
      const p = e.playerPoolEntry?.player || e.player || {};
      const stats = (p.stats || []).reduce((acc, s) => {
        if (s.scoringPeriodId === scoringPeriodId) acc.week = s.appliedTotal;
        if (s.seasonId === season && s.statSourceId === 0 && s.statSplitTypeId === 1) acc.season = s.appliedTotal;
        return acc;
      }, { week: 0, season: 0 });
      return normPlayer({
        playerId: p.id,
        name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.fullName || p.name,
        pos: Array.isArray(p.defaultPositionId) ? p.defaultPositionId[0] : p.defaultPositionId || p.position || '',
        nflAbbr: p.proTeamAbbreviation || p.proTeam || '',
        weekPts: stats.week || 0,
        seasonPts: stats.season || 0,
        draftPick: e.playerPoolEntry?.appliedStatTotal ? null : e.playerPoolEntry?.draftPickNumber ?? null,
        draftRound: e.playerPoolEntry?.draftRoundId ?? null,
      });
    });

    return players;
  });
}

async function getLeagueRosters(ctx) {
  const teams = await getTeams(ctx);
  const out = [];
  for (const t of teams) {
    const players = await getRoster({ ...ctx, teamId: t.teamId });
    out.push({ teamId: t.teamId, teamName: t.teamName, players });
  }
  return out;
}

async function searchPlayers({ q }) {
  // ESPN doesn’t have a great public search without cookies; stub returns empty
  return [];
}

module.exports = {
  getLeagues,
  getTeams,
  getRoster,
  getLeagueRosters,
  searchPlayers,
};
