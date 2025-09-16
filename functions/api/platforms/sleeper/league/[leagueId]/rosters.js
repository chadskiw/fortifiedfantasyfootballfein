/* ============================================================================
   Path: functions/api/platforms/sleeper/league/[leagueId]/rosters.js
   File: rosters.js
   Project: FEIN · Fortified Fantasy
   Description:
     GET /api/platforms/sleeper/league/:leagueId/rosters?season=2025[&include=players]
     - Returns all rosters in a Sleeper league.
     - If include=players, also includes a slim players index and attaches
       normalized player objects per roster (FEIN-friendly player shape).
   ============================================================================ */

const THIS_YEAR = new Date().getUTCFullYear();

/* --------------------- utils --------------------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
const badRequest   = (m) => json({ ok:false, error:m }, 400);
const upstreamFail = (m) => json({ ok:false, error:m }, 502);

/* --------------------- normalize --------------------- */
const LINEUP_LABEL_TO_ID = {
  "QB":0, "RB":2, "WR":4, "TE":6,
  "FLEX":23, "WR/TE":24, "WR/RB":25, "RB/TE":26,
  "D/ST":16, "DST":16, "K":17,
  "BN":20, "BE":20, "IR":21,
  "SUPERFLEX":27, "OP":28
};
const normTeam = (x) => String(x || '').trim().toUpperCase();
const normPos  = (x) => {
  const s = String(x || '').trim().toUpperCase();
  return (s === 'DEF') ? 'D/ST' : s;
};

function slotForPos(pos) {
  const P = String(pos || '').toUpperCase();
  if (P === 'QB') return 'QB';
  if (P === 'RB') return 'RB';
  if (P === 'WR') return 'WR';
  if (P === 'TE') return 'TE';
  if (P === 'K')  return 'K';
  if (P === 'DEF' || P === 'DST') return 'D/ST';
  return 'BE';
}

function normalizeRosterEntries(roster, playersIndex) {
  const starters = new Set(roster.starters || []);
  const all = Array.isArray(roster.players) ? roster.players : [];

  return all.map((pid, i) => {
    const meta = playersIndex?.[String(pid)] || {};
    const isStarter = starters.has(pid);
    const slotLabel = isStarter ? slotForPos(meta.position || meta.pos) : 'BE';
    const lineupSlotId = LINEUP_LABEL_TO_ID[slotLabel] ?? -1;

    const teamAbbr = normTeam(meta.team);
    const headshot =
      meta.headshot ||
      (meta.id ? `https://sleepercdn.com/content/nfl/players/${meta.id}.jpg` : '');

    return {
      playerId: meta.id || pid,
      name: meta.full_name || meta.name ||
            (meta.first_name && meta.last_name ? `${meta.first_name} ${meta.last_name}` : (meta.last_name || meta.first_name || 'Player')),
      pos: normPos(meta.position || meta.pos || '—'),
      nflTeam: teamAbbr || '',
      lineupSlotId,
      draftSpot: i + 1,     // placeholder; Sleeper doesn't expose draft pick here
      weekPts: 0,
      seasonPts: 0,
      headshotUrl: headshot
    };
  });
}

/* --------------------- entry --------------------- */
export const onRequestGet = async ({ request, params }) => {
  const leagueId = String(params?.leagueId || "").trim();
  if (!leagueId) return badRequest("leagueId required");

  const url = new URL(request.url);
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const includePlayers = String(url.searchParams.get("include") || "").toLowerCase() === "players";

  try {
    const [leagueRes, usersRes, rostersRes, playersRes] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueId}`),
      fetch(`https://api.sleeper.app/v1/league/${leagueId}/users`),
      fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
      includePlayers ? fetch(`https://api.sleeper.app/v1/players/nfl`) : Promise.resolve(null),
    ]);

    if (!leagueRes.ok)  throw new Error(`Sleeper league ${leagueRes.status}`);
    if (!usersRes.ok)   throw new Error(`Sleeper users ${usersRes.status}`);
    if (!rostersRes.ok) throw new Error(`Sleeper rosters ${rostersRes.status}`);

    const league  = await leagueRes.json().catch(() => null);
    const users   = await usersRes.json();
    const rosters = await rostersRes.json();
    const players = includePlayers && playersRes && playersRes.ok ? await playersRes.json() : null;

    // Slim players index if included
    let playersIndex = null;
    if (players) {
      playersIndex = {};
      for (const [pid, p] of Object.entries(players)) {
        playersIndex[pid] = {
          id: pid,
          full_name: p.full_name || null,
          first_name: p.first_name || null,
          last_name: p.last_name || null,
          name: p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : (p.last_name || p.first_name || '')),
          position: p.position || '',
          team: p.team || '',
          headshot: p.headshot || null
        };
      }
    }

    const userById = new Map(users.map(u => [String(u.user_id), u]));
    const ownersMap = {};
    users.forEach(u => {
      const label = u?.metadata?.team_name || u?.display_name || u?.username || "";
      if (label) ownersMap[String(u.user_id)] = label;
    });

    const out = rosters.map(r => {
      const u = userById.get(String(r.owner_id));
      const display = u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`;
      const base = {
        teamId: Number(r.roster_id),
        teamName: String(display),
        ownerUserId: String(r.owner_id || ""),
        owner: u?.display_name || u?.username || "",
        owners: [u?.display_name || u?.username].filter(Boolean),
        urls: { league: `https://sleeper.com/leagues/${leagueId}` }
      };

      if (!playersIndex) {
        // Return raw players (ids) & starters only
        return {
          ...base,
          roster: {
            starters: r.starters || [],
            players:  r.players  || [],
          }
        };
      }

      // Return normalized FEIN-friendly players for this roster
      return {
        ...base,
        roster: {
          starters: r.starters || [],
          players: normalizeRosterEntries(r, playersIndex)
        }
      };
    });

    return json({
      ok:true,
      platform:"sleeper",
      season,
      leagueId,
      league: { name: league?.name || "" },
      ownersMap,
      includePlayers,
      teams: out
    });
  } catch (e) {
    return upstreamFail(String(e?.message || e));
  }
};
