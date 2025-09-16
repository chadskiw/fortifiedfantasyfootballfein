// GET /api/platforms/:platform/league/:leagueId/teams?season=2025[&include=rosters]
// => {
//   ok, platform, season, leagueId, league, ownersMap, canViewRosters,
//   teams:[{
//     teamId, teamName, abbrev, owner, owners:[], logo, teamAbbrev:null, teamLogo:null, urls:{},
//     roster?: [{ // only when include=rosters and authed
//       playerId, name, positionId?, position?, proTeamId?, team?,
//       lineupSlotId?, lineupSlot?, acquisitionType?, acquisitionDate?, draftPickOverall?
//     }]
//   }]
// }

const THIS_YEAR = new Date().getUTCFullYear();

/* ------ tiny utils ------ */
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
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
const badRequest   = (m) => json({ ok:false, error:m }, 400);
const unauthorized = (m) => json({ ok:false, error:m }, 401);
const upstreamFail = (m) => json({ ok:false, error:m }, 502);

/* ------ creds ------ */
function espnCreds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = (req.headers.get("x-espn-swid") || c.SWID || c.swid || "").trim();
  const s2   = (req.headers.get("x-espn-s2")   || c.espn_s2 || c.ESPN_S2 || "").trim();
  return { SWID, s2 };
}

/* ------ resilient ESPN fetch ------ */
async function espnFetchJSON(url, { SWID, s2 }) {
  const headers = {
    cookie: `SWID=${SWID}; espn_s2=${s2}`,
    accept: "application/json",
    referer: "https://fantasy.espn.com/",
    "user-agent": "FortifiedFantasy/1.0 (+edge)",
    "cache-control": "no-cache",
  };
  // try reads host then main host
  const attempts = [
    url.replace("https://lm-api-reads.", "https://lm-api-reads."),
    url.replace("https://lm-api-reads.", "https://lm-api-"),
  ];
  let lastErr;
  for (const u of attempts) {
    try {
      const r = await fetch(u, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("ESPN fetch failed");
}

/* ------ teams & owners ------ */
async function espnGetLeagueTeams({ leagueId, season, SWID, s2 }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const [mTeam, mSettings] = await Promise.all([
    // mTeam: teams + members/owners (often readable even w/o creds)
    fetch(`${base}?view=mTeam`, {
      headers: {
        accept: "application/json",
        referer: "https://fantasy.espn.com/",
        "user-agent": "FortifiedFantasy/1.0 (+edge)",
        "cache-control": "no-cache",
      }
    }).then(r => {
      if (!r.ok) throw new Error(`ESPN mTeam ${r.status}`);
      return r.json();
    }),
    // league name/settings (nice-to-have)
    fetch(`${base}?view=mSettings`, {
      headers: {
        accept: "application/json",
        referer: "https://fantasy.espn.com/",
        "user-agent": "FortifiedFantasy/1.0 (+edge)",
        "cache-control": "no-cache",
      }
    }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);

  const ownersMap = {};
  (mTeam.members || []).forEach(m => {
    const full = [m.firstName, m.lastName].filter(Boolean).join(" ").trim();
    const name = full || m.displayName || "";
    if (!name) return;
    const id = String(m.id || "");
    ownersMap[id] = name;
    if (id.startsWith("{") && id.endsWith("}")) ownersMap[id.slice(1, -1)] = name;
  });

  const leagueName =
    mSettings?.settings?.name ||
    mTeam?.settings?.name || mTeam?.name || "";

  const teams = (mTeam.teams || []).map(t => {
    const ownerIds = Array.isArray(t.owners) ? t.owners.map(String) : [];
    const ownerNames = ownerIds.map(id => ownersMap[id] || ownersMap[id.replace(/^\{|\}$/g, "")] || id);
    const owner = ownerNames[0] || "";
    const teamName =
      (t.location && t.nickname) ? `${t.location} ${t.nickname}`
                                 : (t.nickname || t.location || `Team ${t.id}`);
    return {
      teamId: Number(t.id),
      teamName,
      abbrev: t.abbrev || null,
      owner,
      owners: ownerNames.filter(Boolean),
      logo: t.logo || null,
      teamAbbrev: null,
      teamLogo: null,
      urls: {
        league: `https://fantasy.espn.com/football/league?leagueId=${leagueId}&seasonId=${season}`,
        team:   t.id ? `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${t.id}&seasonId=${season}` : null,
      }
    };
  });

  return { teams, league: { name: leagueName, settings: mSettings?.settings || null }, ownersMap };
}

/* ------ optional rosters (requires cookies for private leagues) ------ */
async function espnGetLeagueRosters({ leagueId, season, SWID, s2 }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  // mRoster returns every team’s roster in one payload
  const j = await espnFetchJSON(`${base}?view=mRoster`, { SWID, s2 });

  // Build map: teamId -> [players]
  const byTeam = new Map();
  (j.teams || []).forEach(team => {
    const pidList = [];
    (team.roster?.entries || []).forEach(e => {
      const a = e?.playerPoolEntry?.player || {};
      const p = {
        playerId: a.id,
        name: a.fullName || a.name || "",
        positionId: a.defaultPositionId,
        position: a.defaultPositionId, // label left to client if you map ids->labels
        proTeamId: a.proTeamId,
        team: a.proTeamId,
        lineupSlotId: e?.lineupSlotId,
        lineupSlot: e?.lineupSlotId,   // label left to client
        acquisitionType: e?.acquisitionType || e?.status || "",
        acquisitionDate: e?.acquisitionDate || "",
        draftPickOverall: e?.playerPoolEntry?.appliedStatTotal ? undefined : undefined // some leagues include it elsewhere
      };
      // some leagues put acquisition in playerPoolEntry; try fallback
      if (!p.acquisitionType && e?.playerPoolEntry?.status) {
        p.acquisitionType = e.playerPoolEntry.status;
      }
      pidList.push(p);
    });
    byTeam.set(Number(team.id), pidList);
  });

  return byTeam;
}

/* ------ entry ------ */
export const onRequestGet = async ({ request, params }) => {
  const url = new URL(request.url);
  const platform = String(params?.platform || "").toLowerCase();
  const leagueId = String(params?.leagueId || "").trim();
  const season   = Number(url.searchParams.get("season")) || THIS_YEAR;
  const includeRosters = String(url.searchParams.get("include") || "").toLowerCase() === "rosters";

  if (!platform) return badRequest("platform required");
  if (!leagueId) return badRequest("leagueId required");
  if (platform !== "espn") return badRequest(`Unsupported platform: ${platform}`);

  try {
    const { SWID, s2 } = espnCreds(request);
    const { teams, league, ownersMap } = await espnGetLeagueTeams({ leagueId, season, SWID, s2 });

    let canViewRosters = false;
    if (includeRosters) {
      if (!SWID || !s2) {
        // return teams only; caller can prompt to auth
        return json({ ok:true, platform, season, leagueId, league, ownersMap, canViewRosters:false, teams });
      }
      const rosterMap = await espnGetLeagueRosters({ leagueId, season, SWID, s2 });
      teams.forEach(t => { t.roster = rosterMap.get(t.teamId) || []; });
      canViewRosters = true;
    }

    return json({ ok:true, platform, season, leagueId, league, ownersMap, canViewRosters, teams });
  } catch (e) {
    return upstreamFail(String(e?.message || e));
  }
};
