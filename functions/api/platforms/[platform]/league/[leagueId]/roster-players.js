// GET /api/platforms/:platform/league/:leagueId/roster-players?teamId=###&season=YYYY&week=W
// -> { platform, leagueId, season, week, team: { teamId, teamName, owner }, players: [ ...normalizedPlayers ] }
//
// Notes:
//  - ESPN: requires SWID + espn_s2 (via cookies or headers X-ESPN-SWID / X-ESPN-S2)
//  - Sleeper: public
//  - Normalized player: { platform, id, name, position, team, teamAbbrev, proTeam, lineupSlot, status, injury, injuryStatus }

const THIS_YEAR = new Date().getUTCFullYear();

function readCookies(cookieHeader = "") {
  const out = {};
  (cookieHeader || "").split(/;\s*/).forEach((p) => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}
function creds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = (req.headers.get("X-ESPN-SWID") || c.SWID || "").trim();
  const s2   = (req.headers.get("X-ESPN-S2")   || c.espn_s2 || "").trim();
  return { SWID, s2 };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ---------------------------- ESPN helpers ---------------------------- */
async function espnFetchLeagueBlob({ leagueId, season, scoringPeriodId, SWID, s2 }) {
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const views = [
    "mRoster",
    "mTeam",
    "mMatchup",
    "mSettings",
    "mNav"
  ].map(v => `view=${v}`).join("&");

  const url = `${base}?${views}&scoringPeriodId=${scoringPeriodId || ""}`;
  const r = await fetch(url, {
    headers: {
      cookie: `SWID=${SWID}; espn_s2=${s2}`,
      accept: "application/json",
      referer: "https://fantasy.espn.com/",
      "user-agent": "FortifiedFantasy/1.0 (+cf-pages)"
    }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ESPN ${r.status}: ${body.slice(0,200)}`);
  }
  return r.json();
}

function espnNormalizeRoster({ blob, teamId, scoringPeriodId }) {
  const teams = Array.isArray(blob?.teams) ? blob.teams : [];
  const t = teams.find(tt => Number(tt.id) === Number(teamId));
  if (!t) throw new Error(`Team ${teamId} not found in league`);

  // figure target period
  const spId = scoringPeriodId || blob?.scoringPeriodId || blob?.status?.currentMatchupPeriod || 1;

  const entries = Array.isArray(t?.roster?.entries) ? t.roster.entries : [];
  const players = entries.map(e => {
    const p = e.playerPoolEntry?.player || e.player || {};
    const full = p?.fullName || p?.name || "";
    const proTeam = p?.proTeamId != null ? p.proTeamId : p?.proTeamAbbreviation || "";
    const teamAbbrev = p?.proTeamAbbreviation || p?.proTeam || "";
    const lineupSlot = (e.lineupSlotId != null ? e.lineupSlotId : e.lineupSlot)?.toString();
    // Map ESPN lineupSlotId to label quickly (common ones)
    const slotLabel = ({
      "0":"QB","2":"RB","4":"WR","6":"TE",
      "23":"FLEX","16":"D/ST","17":"K",
      "20":"BE","21":"IR"
    })[lineupSlot] || lineupSlot || "";

    // ESPN numeric id for photos:
    const espnId = Number(p?.id || p?.playerId || e?.playerId || 0) || null;
    const primaryPos = (Array.isArray(p?.eligibleSlots) && p?.defaultPositionId!=null)
      ? (["QB","RB","WR","TE","K","DST"][p.defaultPositionId] || "")
      : (Array.isArray(p?.defaultPosition) ? p.defaultPosition[0] : p?.position || "");

    return {
      platform: "espn",
      id: espnId,              // numeric; use for headshots
      name: full,
      position: p?.defaultPosition || p?.primaryPosition || primaryPos || "",
      team: teamAbbrev || p?.proTeam || "",
      teamAbbrev: teamAbbrev || "",
      proTeam,
      lineupSlot: slotLabel,
      status: p?.status || "",
      injury: p?.injuryStatus?.injuryStatus || p?.injuryStatus || "",
      injuryStatus: p?.injuryStatus || ""
    };
  });

  return {
    team: {
      teamId: t.id,
      teamName: t?.location && t?.nickname ? `${t.location} ${t.nickname}` : (t?.name || t?.nickname || `Team ${t?.id}`),
      owner: Array.isArray(t?.owners) && t.owners[0] ? t.owners[0] : (t?.primaryOwner || "")
    },
    players
  };
}

/* --------------------------- Sleeper helpers -------------------------- */
async function sleeperFetch(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Sleeper ${r.status}`);
  return r.json();
}
async function sleeperRosterForTeam({ leagueId, season, teamId, week }) {
  // Get rosters + users; teamId for Sleeper is roster_id
  const [rosters, users] = await Promise.all([
    sleeperFetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    sleeperFetch(`https://api.sleeper.app/v1/league/${leagueId}/users`)
  ]);
  const uById = new Map(users.map(u => [u.user_id, u]));
  const r = rosters.find(rr => Number(rr.roster_id) === Number(teamId));
  if (!r) throw new Error(`Team ${teamId} not found in Sleeper league`);

  // Optional weekly lineup data (starters/IR etc.)
  // Sleeper has matchups endpoint per week; if you want exact slot labels, fetch those.
  // For now, mark roster players; starters array indicates active lineup.
  const starters = Array.isArray(r.starters) ? new Set(r.starters) : new Set();

  const players = Array.isArray(r.players) ? r.players : [];
  const norm = players.map(pid => ({
    platform: "sleeper",
    id: pid, // string id (use your own player DB to map to ESPN if needed)
    name: "", // can be filled client-side from your FP/ESPN tables
    position: "", // unknown without player DB; leave blank
    team: "",
    teamAbbrev: "",
    proTeam: "",
    lineupSlot: starters.has(pid) ? "START" : "BENCH",
    status: "",
    injury: "",
    injuryStatus: ""
  }));

  const owner = uById.get(r.owner_id);
  return {
    team: {
      teamId: r.roster_id,
      teamName: owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`,
      owner: owner?.display_name || ""
    },
    players: norm
  };
}

/* --------------------------------------------------------------------- */

export const onRequestGet = async ({ params, request }) => {
  try {
    const platform = String(params.platform || "").toLowerCase();
    const leagueId = String(params.leagueId || "").trim();

    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || THIS_YEAR;
    const week   = Number(url.searchParams.get("week"))   || 1;
    const teamId = url.searchParams.get("teamId");

    if (!leagueId) return json({ error: "Missing leagueId" }, 400);
    if (!teamId)   return json({ error: "Missing teamId" }, 400);

    if (platform === "espn") {
      const { SWID, s2 } = creds(request);
      if (!SWID || !s2) return json({ error: "Missing SWID/espn_s2. Link first via /api/fein-auth." }, 401);

      const blob = await espnFetchLeagueBlob({
        leagueId, season, scoringPeriodId: week, SWID, s2
      });
      const { team, players } = espnNormalizeRoster({ blob, teamId, scoringPeriodId: week });

      return json({ platform, leagueId, season, week, team, players });
    }

    if (platform === "sleeper") {
      const { team, players } = await sleeperRosterForTeam({ leagueId, season, teamId, week });
      return json({ platform, leagueId, season, week, team, players });
    }

    return json({ error: `Unsupported platform: ${platform}` }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }
};
