// Cloudflare Pages Function: GET /api/platforms/:platform/leagues?season=2025[&user=<sleeperUser>]
// Returns: { ok, platform, season, leagues: [{ leagueId, leagueName, size, myTeamId, myTeamName, urls:{...} }] }

const THIS_YEAR = new Date().getUTCFullYear();

/* ------------------------------ tiny utils ------------------------------ */
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
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}
const badRequest = (m) => json({ ok: false, error: m }, 400);
const unauthorized = (m) => json({ ok: false, error: m }, 401);
const upstreamFail = (m) => json({ ok: false, error: m }, 502);

/* ------------------------------ ESPN adapter ------------------------------ */
// Read ESPN cookies/headers (keep SWID braces)
function espnCreds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = (req.headers.get("x-espn-swid") || c.SWID || "").trim();
  const s2   = (req.headers.get("x-espn-s2")   || c.espn_s2 || "").trim();
  return { SWID, s2 };
}

async function espnGetFanBlob({ SWID, s2 }) {
  const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(SWID)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      cookie: `SWID=${SWID}; espn_s2=${s2}`,
      accept: "application/json",
      referer: "https://www.espn.com/",
      "user-agent": "FortifiedFantasy/1.0 (+cloudflare-pages)",
      "cache-control": "no-cache",
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ESPN Fan API ${r.status} :: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// Map Fan API -> leagues model
function espnMapLeaguesFromFan(fan, { season, gameId = 1 /* 1=FFL */ }) {
  const prefs = Array.isArray(fan?.preferences) ? fan.preferences : [];
  // typeId 9 = Fantasy League Manager
  const fantasy = prefs.filter(p => p?.typeId === 9 && p?.metaData?.entry);

  const filtered = fantasy.filter(p => {
    const e = p.metaData.entry;
    if (Number(e.gameId) !== Number(gameId)) return false;
    if (season && Number(e.seasonId) !== Number(season)) return false;
    return true;
  });

  return filtered.map(p => {
    const e = p.metaData.entry;
    const g = Array.isArray(e.groups) && e.groups[0] ? e.groups[0] : {};
    return {
      leagueId: Number(g.groupId),
      leagueName: String(g.groupName || e.name || `League ${g.groupId}`),
      size: g.groupSize != null ? Number(g.groupSize) : null,
      myTeamId: Number(e.entryId),
      myTeamName: String(e.entryMetadata?.teamName || ""),
      teamAbbrev: e.entryMetadata?.teamAbbrev || null,
      seasonId: Number(e.seasonId),
      urls: {
        team: e.entryURL || null,
        league: g.href || null,
        fantasycast: g.fantasyCastHref || null,
        scoreboard: e.scoreboardFeedURL || null,
      },
    };
  });
}

async function handleEspn(request, url) {
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const gameId = Number(url.searchParams.get("gameId")) || 1; // 1=FFL
  const { SWID, s2 } = espnCreds(request);
  if (!SWID || !s2) {
    return unauthorized("Missing SWID/espn_s2. Pass cookies or X-ESPN-SWID / X-ESPN-S2 headers.");
  }
  try {
    const fan = await espnGetFanBlob({ SWID, s2 });
    const leagues = espnMapLeaguesFromFan(fan, { season, gameId });
    return json({ ok: true, platform: "espn", season, leagues });
  } catch (e) {
    return upstreamFail(String(e));
  }
}

/* ----------------------------- Sleeper adapter ---------------------------- */
async function sleeperResolveUser(user) {
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(user)}`);
  if (!r.ok) throw new Error(`Sleeper user lookup ${r.status}`);
  return r.json(); // { user_id, username, ... }
}
async function sleeperGetLeagues(userId, season) {
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`);
  if (!r.ok) throw new Error(`Sleeper leagues ${r.status}`);
  return r.json();
}
function sleeperMapLeagues(arr = []) {
  return arr.map(l => ({
    leagueId: String(l.league_id),
    leagueName: String(l.name || `League ${l.league_id}`),
    size: l.total_rosters != null ? Number(l.total_rosters) : null,
    myTeamId: null,        // can be filled by a follow-up /rosters call
    myTeamName: "",
    seasonId: Number(l.season || l.settings?.season),
    urls: { league: `https://sleeper.com/leagues/${l.league_id}` },
  }));
}
async function handleSleeper(request, url) {
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const user = (url.searchParams.get("user") || "").trim() ||
               (request.headers.get("x-sleeper-user") || "").trim();
  if (!user) return badRequest("Sleeper requires ?user=<usernameOrId> or X-SLEEPER-USER header.");
  try {
    const u = await sleeperResolveUser(user);
    const leagues = await sleeperGetLeagues(u.user_id, season);
    return json({ ok: true, platform: "sleeper", season, leagues: sleeperMapLeagues(leagues) });
  } catch (e) {
    return upstreamFail(String(e));
  }
}

/* -------------------------------- Handler -------------------------------- */
export const onRequestGet = async ({ request, params }) => {
  const url = new URL(request.url);
  const platform = String(params?.platform || "").toLowerCase().trim();
  if (!platform) return badRequest("platform param required (espn, sleeper, ...).");

  switch (platform) {
    case "espn":    return handleEspn(request, url);
    case "sleeper": return handleSleeper(request, url);
    default:        return badRequest(`Unsupported platform: ${platform}`);
  }
};

// (Optional) CORS preflight if you need it:
// export const onRequestOptions = () =>
//   new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-espn-swid,x-espn-s2,x-sleeper-user" }});
