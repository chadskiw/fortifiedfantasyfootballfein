// functions/api/fans.js
// GET /api/fans            -> { leagues:[{sport, gameId, leagueId, leagueName, teamId, teamName, season, entryURL}] }
// GET /api/fans?swid={SWID}
// Requires ESPN cookies (SWID, espn_s2) present on YOUR domain or sent via X-ESPN-* headers.

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

function normSWID(raw) {
  if (!raw) return "";
  const b = String(raw).replace(/[{}]/g, "").trim();
  return b ? `{${b}}` : "";
}

function creds(req) {
  const c = readCookies(req.headers.get("cookie") || "");
  const SWID = normSWID(req.headers.get("X-ESPN-SWID") || c.SWID || "");
  const s2   = (req.headers.get("X-ESPN-S2") || c.espn_s2 || "").trim();
  return { SWID, s2 };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function espnJSON(url, { SWID, s2 }) {
  const r = await fetch(url, {
    headers: {
      cookie: `SWID=${SWID}; espn_s2=${s2}`,
      accept: "application/json, text/plain, */*",
      "user-agent": "FortifiedFantasy/1.0 (+cloudflare-pages)",
      referer: "https://www.espn.com/fantasy/",
    },
    redirect: "follow",
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`ESPN ${r.status} ${url} :: ${t.slice(0,180)}`);
  }
  return r.json();
}

export const onRequestGet = async ({ request }) => {
  const { SWID, s2 } = creds(request);
  if (!SWID || !s2) return json({ error: "Missing SWID/espn_s2" }, 401);

  const url = new URL(request.url);
  const swidQ = normSWID(url.searchParams.get("swid") || SWID);
  const fanURL = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swidQ)}`;

  try {
    const data = await espnJSON(fanURL, { SWID, s2 });
    const prefs = Array.isArray(data?.preferences) ? data.preferences : [];

    // Flatten all fantasy teams across sports (typeId 9 = Fantasy League Manager)
    const leagues = [];
    for (const p of prefs) {
      if (Number(p?.typeId) !== 9) continue;
      const e = p?.metaData?.entry;
      if (!e) continue;

      const gameId  = Number(e.gameId);               // 1=FFL, 2=FLB, 3=FBA, 4=FHL, 5=WBB
      const sportAbbrev = String(e.abbrev || "").toUpperCase(); // e.g., "FFL"
      const season  = Number(e.seasonId);
      const teamId  = Number(e.entryId);
      const teamName = String(e.entryMetadata?.teamName || `Team ${teamId}`);
      const groups   = Array.isArray(e.groups) ? e.groups : [];

      for (const g of groups) {
        const leagueId = Number(g.groupId);
        const leagueName = String(g.groupName || `League ${leagueId}`);
        leagues.push({
          sport: sportAbbrev,
          gameId,
          leagueId,
          leagueName,
          teamId,
          teamName,
          season,
          entryURL: e.entryURL || null,
          fantasyCastHref: g.fantasyCastHref || null,
        });
      }
    }

    return json({ leagues });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
};
