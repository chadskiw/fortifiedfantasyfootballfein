// GET /api/platforms/:platform/league/:leagueId/teams?season=2025
// => { ok, platform, season, leagueId, teams:[{ teamId, teamName, abbrev, owner, owners:[], logo, teamAbbrev, teamLogo, urls:{} }] }

import { toAbbr, teamLogoUrl } from "/_lib/nfl-logos.js";

const THIS_YEAR = new Date().getUTCFullYear();

/* utils */
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function badRequest(msg){ return json({ ok:false, error:msg }, 400); }
function unauthorized(msg){ return json({ ok:false, error:msg }, 401); }
function upstreamFail(msg){ return json({ ok:false, error:msg }, 502); }

/* ESPN */
function espnCreds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = (req.headers.get("x-espn-swid") || c.SWID || "").trim();
  const s2   = (req.headers.get("x-espn-s2")   || c.espn_s2 || "").trim();
  return { SWID, s2 };
}

async function espnGetLeagueTeams({ leagueId, season, SWID, s2 }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = `${base}?view=mTeam`; // teams + owners
  const r = await fetch(url, {
    headers: {
      cookie: `SWID=${SWID}; espn_s2=${s2}`,
      accept: "application/json",
      referer: "https://fantasy.espn.com/",
      "user-agent": "FortifiedFantasy/1.0 (+cloudflare-pages)",
      "cache-control": "no-cache",
    }
  });
  if (!r.ok) throw new Error(`ESPN mTeam ${r.status}`);
  const j = await r.json();

  const ownersById = new Map();
  (j.members || []).forEach(m => {
    const n = [m.firstName, m.lastName].filter(Boolean).join(" ").trim();
    ownersById.set(String(m.id), n || m.displayName || "");
  });

  const teams = (j.teams || []).map(t => {
    const ownerList = (t.owners || []).map(id => ownersById.get(String(id)) || String(id));
    const owner = ownerList[0] || "";
    const name = (t.location && t.nickname) ? `${t.location} ${t.nickname}` : (t.nickname || t.location || `Team ${t.id}`);
    const logo = t.logo || null;

    // ESPN doesn't expose NFL team abbreviation per fantasy team directly; leave null here.
    const teamAbbrev = null;
    const teamLogo = null;

    return {
      teamId: Number(t.id),
      teamName: name,
      abbrev: t.abbrev || null,
      owner,
      owners: ownerList,
      logo,
      teamAbbrev,
      teamLogo,
      urls: {}
    };
  });

  return teams;
}

/* Sleeper */
async function sleeperGetLeagueUsers(leagueId) {
  const [leagueRes, usersRes, rostersRes] = await Promise.all([
    fetch(`https://api.sleeper.app/v1/league/${leagueId}`),
    fetch(`https://api.sleeper.app/v1/league/${leagueId}/users`),
    fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
  ]);
  if (!leagueRes.ok) throw new Error(`Sleeper league ${leagueRes.status}`);
  if (!usersRes.ok) throw new Error(`Sleeper users ${usersRes.status}`);
  if (!rostersRes.ok) throw new Error(`Sleeper rosters ${rostersRes.status}`);
  const users   = await usersRes.json();
  const rosters = await rostersRes.json();

  const userMap = new Map(users.map(u => [String(u.user_id), u]));
  const teams = rosters.map(r => {
    const u = userMap.get(String(r.owner_id));
    const display = u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`;

    // Sleeper has no single NFL team for a fantasy team; we keep these null here too.
    const teamAbbrev = null;
    const teamLogo = null;

    return {
      teamId: Number(r.roster_id),
      teamName: String(display),
      abbrev: null,
      owner: u?.display_name || u?.username || "",
      owners: [u?.display_name || u?.username].filter(Boolean),
      logo: u?.metadata?.avatar || null,
      teamAbbrev,
      teamLogo,
      urls: { league: `https://sleeper.com/leagues/${leagueId}` }
    };
  });

  return teams;
}

/* entry */
export const onRequestGet = async ({ request, params }) => {
  const url = new URL(request.url);
  const platform = String(params?.platform || "").toLowerCase();
  const leagueId = String(params?.leagueId || "").trim();
  const season   = Number(url.searchParams.get("season")) || THIS_YEAR;

  if (!platform) return badRequest("platform required");
  if (!leagueId) return badRequest("leagueId required");

  try {
    switch (platform) {
      case "espn": {
        const { SWID, s2 } = espnCreds(request);
        if (!SWID || !s2) return unauthorized("Missing SWID/espn_s2");
        const teams = await espnGetLeagueTeams({ leagueId, season, SWID, s2 });
        return json({ ok:true, platform, season, leagueId, teams });
      }
      case "sleeper": {
        const teams = await sleeperGetLeagueUsers(leagueId);
        return json({ ok:true, platform, season, leagueId, teams });
      }
      default:
        return badRequest(`Unsupported platform: ${platform}`);
    }
  } catch (e) {
    return upstreamFail(String(e));
  }
};
