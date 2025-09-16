/* ============================================================================
   Path: functions/api/platforms/sleeper/adapter.js
   File: adapter.js
   Project: FEIN · Fortified Fantasy
   Description:
     Sleeper adapter used by FEIN routes. Provides high-level helpers that
     return FEIN-normalized objects via the shared normalize module:
       - getLeagues({ season, user?, userId? })
       - getTeams({ leagueId })
       - getRoster({ leagueId, teamId })                // hydrated players
       - getLeagueRosters({ leagueId, includePlayers }) // batched
       - searchPlayers({ q, limit })
   ============================================================================ */

const { LRU } = require('../shared/cache');
const { jsonFetch } = require('../shared/http');
const { league: normLeague, team: normTeam, player: normPlayer } = require('../shared/normalize');

const cache = new LRU(300);
const BASE = 'https://api.sleeper.app/v1';

// --- tiny fetch with timeout so we don't hang the edge function
async function fetchJSON(url, { timeout = 10_000, headers } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// Resolve username → user_id when needed
async function resolveUserId(userOrId) {
  const s = String(userOrId || '').trim();
  if (!s) throw new Error('user (username or user_id) required');
  if (/^\d{6,}$/.test(s)) return s;
  const key = `slp:user:${s}`;
  return cache.remember(key, 5 * 60_000, async () => {
    const j = await fetchJSON(`${BASE}/user/${encodeURIComponent(s)}`);
    if (!j?.user_id) throw new Error(`Sleeper user not found: ${s}`);
    return String(j.user_id);
  });
}

// Slim players index (name/pos/team/headshot). ~few MB cached in LRU
async function getPlayersIndexSlim() {
  const key = 'slp:players:slim:v1';
  return cache.remember(key, 10 * 60_000, async () => {
    const all = await fetchJSON(`${BASE}/players/nfl`);
    const out = {};
    for (const [pid, p] of Object.entries(all)) {
      const name =
        p.full_name ||
        (p.first_name && p.last_name
          ? `${p.first_name} ${p.last_name}`
          : (p.last_name || p.first_name || ''));
      out[pid] = {
        id: pid,
        name,
        position: p.position || '',
        team: p.team || '',
        headshot: p.headshot || null
      };
    }
    return out;
  });
}

/**
 * getLeagues — list user's leagues for a season.
 * Accepts either { userId } or { user } (username).
 */
async function getLeagues({ season, userId, user }) {
  const yr = Number(season) || new Date().getUTCFullYear();
  const uid = userId || (user ? await resolveUserId(user) : null);
  if (!uid) return []; // caller didn't supply identity; keep adapter safe
  const key = `slp:leagues:${uid}:${yr}`;
  const leagues = await cache.remember(key, 60_000, async () => {
    return fetchJSON(`${BASE}/user/${uid}/leagues/nfl/${yr}`);
  });
  return leagues.map((l) =>
    normLeague({
      platform: 'sleeper',
      leagueId: l.league_id,
      season: l.season || yr,
      name: l.name || '',
      size: l.total_rosters || 0,
      scoringSettings: l.scoring_settings || null,
      url: `https://sleeper.com/leagues/${l.league_id}`
    })
  );
}

/**
 * getTeams — teams (roster_id + owner) for a league.
 * Mirrors your existing implementation but adds small guards/caching.
 */
async function getTeams({ leagueId }) {
  const key = `slp:teams:${leagueId}`;
  return cache.remember(key, 30_000, async () => {
    const [users, rosters] = await Promise.all([
      fetchJSON(`${BASE}/league/${leagueId}/users`),
      fetchJSON(`${BASE}/league/${leagueId}/rosters`)
    ]);
    const byOwner = Object.fromEntries(users.map((u) => [String(u.user_id), u]));
    return rosters.map((r) =>
      normTeam({
        teamId: r.roster_id,
        teamName:
          byOwner[String(r.owner_id)]?.metadata?.team_name ||
          byOwner[String(r.owner_id)]?.display_name ||
          byOwner[String(r.owner_id)]?.username ||
          `Roster ${r.roster_id}`,
        owner: r.owner_id || null,
        record: r.settings
          ? { wins: r.settings.wins, losses: r.settings.losses }
          : null,
        logo: byOwner[String(r.owner_id)]?.avatar
          ? `https://sleepercdn.com/avatars/${byOwner[String(r.owner_id)].avatar}`
          : null
      })
    );
  });
}

/**
 * getRoster — hydrated player list for one team.
 * Uses slim players index; returns FEIN-normalized players.
 */
async function getRoster({ leagueId, teamId }) {
  const key = `slp:roster:${leagueId}:${teamId}`;
  return cache.remember(key, 20_000, async () => {
    const [rosters, idx] = await Promise.all([
      fetchJSON(`${BASE}/league/${leagueId}/rosters`),
      getPlayersIndexSlim()
    ]);
    const team = rosters.find((r) => String(r.roster_id) === String(teamId));
    const ids = team?.players || [];
    const starters = new Set(team?.starters || []);
    return ids.map((id, i) => {
      const meta = idx[String(id)] || {};
      const pos = String(meta.position || '').toUpperCase();
      const slot =
        starters.has(id)
          ? (pos === 'DEF' ? 'D/ST' : pos || 'FLEX')
          : 'BE';

      return normPlayer({
        playerId: id,
        name: meta.name || String(id),
        pos: pos === 'DEF' ? 'D/ST' : pos,
        nflAbbr: (meta.team || '').toUpperCase(),
        lineupSlot: slot,
        draftSpot: i + 1, // placeholder (Sleeper draft slot is not here)
        weekPts: 0,
        seasonPts: 0,
        headshot:
          meta.headshot ||
          (meta.id ? `https://sleepercdn.com/content/nfl/players/${meta.id}.jpg` : null)
      });
    });
  });
}

/**
 * getLeagueRosters — batched rosters for all teams.
 * includePlayers=false -> only roster ids; true -> normalized players.
 */
async function getLeagueRosters({ leagueId, includePlayers = true }) {
  const key = `slp:leagueRosters:${leagueId}:${includePlayers ? 'full' : 'ids'}`;
  return cache.remember(key, 20_000, async () => {
    const [users, rosters, idx] = await Promise.all([
      fetchJSON(`${BASE}/league/${leagueId}/users`),
      fetchJSON(`${BASE}/league/${leagueId}/rosters`),
      includePlayers ? getPlayersIndexSlim() : Promise.resolve(null)
    ]);

    const userById = Object.fromEntries(users.map((u) => [String(u.user_id), u]));

    return rosters.map((r) => {
      const u = userById[String(r.owner_id)];
      const teamName =
        u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`;

      const base = {
        teamId: r.roster_id,
        teamName,
        owner: String(r.owner_id || ''),
        starters: r.starters || []
      };

      if (!includePlayers) {
        return { ...base, players: r.players || [] };
      }

      const startersSet = new Set(r.starters || []);
      const players = (r.players || []).map((id, i) => {
        const meta = idx?.[String(id)] || {};
        const pos = String(meta.position || '').toUpperCase();
        const slot = startersSet.has(id)
          ? (pos === 'DEF' ? 'D/ST' : pos || 'FLEX')
          : 'BE';

        return normPlayer({
          playerId: id,
          name: meta.name || String(id),
          pos: pos === 'DEF' ? 'D/ST' : pos,
          nflAbbr: (meta.team || '').toUpperCase(),
          lineupSlot: slot,
          draftSpot: i + 1,
          weekPts: 0,
          seasonPts: 0,
          headshot:
            meta.headshot ||
            (meta.id ? `https://sleepercdn.com/content/nfl/players/${meta.id}.jpg` : null)
        });
      });

      return { ...base, players };
    });
  });
}

/**
 * searchPlayers — simple local search over slim index
 * q: text (matches name/team/position), limit: number
 */
async function searchPlayers({ q, limit = 25 } = {}) {
  const idx = await getPlayersIndexSlim();
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];

  const hits = [];
  for (const p of Object.values(idx)) {
    const hay =
      `${p.name || ''}|${(p.position || '').toLowerCase()}|${(p.team || '').toLowerCase()}`.toLowerCase();
    if (hay.includes(needle)) {
      hits.push(
        normPlayer({
          playerId: p.id,
          name: p.name,
          pos: p.position,
          nflAbbr: p.team,
          headshot: p.headshot || null
        })
      );
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

module.exports = {
  getLeagues,
  getTeams,
  getRoster,
  getLeagueRosters,
  searchPlayers
};
