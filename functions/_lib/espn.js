// functions/_lib/espn.js
import { THIS_YEAR, readCookies, json, unauthorized, upstreamFail } from "../_lib/http.js";

// Reads ESPN cookies/headers. Keep braces in SWID.
export function espnCreds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = (req.headers.get("x-espn-swid") || c.SWID || "").trim();
  const s2   = (req.headers.get("x-espn-s2")   || c.espn_s2 || "").trim();
  return { SWID, s2 };
}

// Fan API -> user fantasy objects
export async function espnGetFanBlob({ SWID, s2 }) {
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

// Map Fan API -> our leagues model
export function espnMapLeaguesFromFan(fan, { season, gameId = 1 /* 1 = FFL */ }) {
  const prefs = Array.isArray(fan?.preferences) ? fan.preferences : [];
  // typeId 9 = Fantasy League Manager (ESPN internal)
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

export async function handleEspn(request, url) {
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const gameId = Number(url.searchParams.get("gameId")) || 1; // 1=FFL, 2=FLB, 4=FHL etc.

  const { SWID, s2 } = espnCreds(request);
  if (!SWID || !s2) {
    return unauthorized("Missing SWID/espn_s2. Link first via /api/espn/link or pass X-ESPN-SWID / X-ESPN-S2 headers.");
  }

  try {
    const fan = await espnGetFanBlob({ SWID, s2 });
    const leagues = espnMapLeaguesFromFan(fan, { season, gameId });
    return json({ ok:true, platform: "espn", season, leagues });
  } catch (e) {
    return upstreamFail(String(e));
  }
}
