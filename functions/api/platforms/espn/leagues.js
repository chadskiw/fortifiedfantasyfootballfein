// functions/api/leagues.js
// GET /api/leagues?season=2025[&gameId=1]
// => { season, leagues: [{ leagueId, leagueName, size, myTeamId, myTeamName, teamAbbrev, seasonId, urls:{...} }] }

const THIS_YEAR = new Date().getUTCFullYear();

/* ----------------------- helpers: cookies, headers ----------------------- */
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

function normalizeSwid(swidRaw = "") {
  const s = String(swidRaw || "").trim();
  if (!s) return "";
  // Keep braces for ESPN fan API: "{...}"
  if (/^\{.*\}$/.test(s)) return s;
  // Some flows strip them; re-wrap
  return `{${s.replace(/^\{|\}$/g, "")}}`;
}

function getHeader(headers, name) {
  // CF Workers headers are case-insensitive, but be defensive
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase());
}

async function tryServerCreds(request) {
  // Optional: ask your backend for server-held creds (non-fatal if missing)
  try {
    const base = new URL(request.url).origin;
    const u = new URL("/api/espn-auth/creds", base);
    const r = await fetch(u.toString(), {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    const SWID = normalizeSwid(j.SWID || j.swid || "");
    const s2 = String(j.s2 || j.espn_s2 || "").trim();
    if (SWID && s2) return { SWID, s2, source: "server" };
    return null;
  } catch {
    return null;
  }
}

async function creds(request) {
  const headers = request.headers;
  const cookieHeader = headers.get("cookie") || "";
  const c = readCookies(cookieHeader);

  // Prefer explicit headers (from your frontend helper)
  let SWID =
    getHeader(headers, "X-ESPN-SWID") ||
    c.SWID ||
    "";
  let s2 =
    getHeader(headers, "X-ESPN-S2") ||
    c.espn_s2 ||
    "";

  SWID = normalizeSwid(SWID);
  s2 = String(s2 || "").trim();

  if (SWID && s2) return { SWID, s2, source: "header/cookie" };

  // Fallback: try server-held creds
  const srv = await tryServerCreds(request);
  if (srv) return srv;

  return { SWID: "", s2: "", source: "missing" };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/* ----------------------------- ESPN Fan API ------------------------------ */
async function getFanBlob({ SWID, s2 }) {
  if (!SWID || !s2) throw new Error("Missing SWID/espn_s2");
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
    throw new Error(`Fan API ${r.status} :: ${body.slice(0, 240)}`);
  }
  return r.json();
}

/* ----------------------- map fan.preferences -> model --------------------- */
function mapLeaguesFromFan(fan, { season, gameId = 1 /* 1=FFL,2=FLB,4=FHL,10=NBA */ }) {
  const prefs = Array.isArray(fan?.preferences) ? fan.preferences : [];
  // typeId 9 = Fantasy League Manager
  const fantasy = prefs.filter((p) => p?.typeId === 9 && p?.metaData?.entry);

  const filtered = fantasy.filter((p) => {
    const e = p.metaData.entry || {};
    if (Number(e.gameId) !== Number(gameId)) return false;
    if (season && Number(e.seasonId) !== Number(season)) return false;
    return true;
  });

  return filtered.map((p) => {
    const e = p.metaData.entry || {};
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
        teamLogoUrl: e.logoUrl || null,
        league: g.href || null,
        fantasycast: g.fantasyCastHref || null,
        scoreboard: e.scoreboardFeedURL || null,
      },
    };
  });
}

/* -------------------------------- handler -------------------------------- */
export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const gameId = Number(url.searchParams.get("gameId")) || 1; // default NFL

  try {
    const { SWID, s2, source } = await creds(request);
    if (!SWID || !s2) {
      return json(
        {
          ok: false,
          error: "Missing SWID/espn_s2. Link first via /api/espn-auth/forward or send headers.",
          hint: "Client can send X-ESPN-SWID and X-ESPN-S2 headers (or set SWID/espn_s2 cookies).",
        },
        401
      );
    }

    const fan = await getFanBlob({ SWID, s2 });
    const leagues = mapLeaguesFromFan(fan, { season, gameId });

    return json({
      ok: true,
      season,
      gameId,
      source,
      leagues,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "Failed to load leagues.",
        detail: String(e && e.message ? e.message : e),
      },
      502
    );
  }
};
