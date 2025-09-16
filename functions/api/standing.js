// functions/api/standing.js

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0"
    },
  });
}
function badRequest(msg, code = 400) { return json({ error: msg || "bad request" }, code); }

function extractAuthBits(request) {
  const h = request.headers;
  const swidHdr = h.get("x-espn-swid") || h.get("X-ESPN-SWID") || "";
  const s2Hdr   = h.get("x-espn-s2")   || h.get("X-ESPN-S2")   || "";
  const cookie  = h.get("cookie") || h.get("Cookie") || "";
  const swidCk  = (cookie.match(/(?:^|;\s*)SWID=([^;]+)/i)?.[1]) || "";
  const s2Ck    = (cookie.match(/(?:^|;\s*)espn_s2=([^;]+)/i)?.[1]) || "";

  let SWID = (swidHdr || swidCk || "").trim();
  let S2   = (s2Hdr   || s2Ck   || "").trim();

  if (SWID && !/^\{.*\}$/.test(SWID)) {
    SWID = SWID.replace(/^"+|"+$/g, "");
    SWID = `{${SWID.replace(/^\{|\}$/g, "")}}`;
  }
  SWID = SWID.replace(/^\{\{/, "{").replace(/\}\}$/, "}");
  return { SWID, S2 };
}

function teamDisplayName(t) {
  const location = t?.location ?? t?.teamLocation ?? "";
  const nick     = t?.nickname ?? t?.teamNickname ?? "";
  const name     = t?.name ?? t?.teamName ?? "";
  const composed = `${location || ""} ${nick || ""}`.trim();
  return (name || composed || `Team ${t?.id ?? t?.teamId ?? ""}`).trim();
}
function buildMemberMap(members) {
  const out = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    const id = m?.id ?? m?.membershipId;
    if (!id) continue;
    const disp = m?.displayName || [m?.firstName, m?.lastName].filter(Boolean).join(" ") || String(id);
    out.set(String(id), disp);
  }
  return out;
}

// --- Robust ESPN fetch with browser-ish headers + fallback host ---
async function fetchEspnLeagueJson({ leagueId, season, cookieHeader }) {
  const path = `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}`;
  const views = ["mTeam","mStandings","mMembers"].map(v => `view=${v}`).join("&");

  const makeHeaders = () => ({
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "cookie": cookieHeader,
    "origin": "https://fantasy.espn.com",
    "referer": "https://fantasy.espn.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
    "x-fantasy-platform": "desktop",
    "x-fantasy-source": "kona",
    "x-requested-with": "XMLHttpRequest",
  });

  // Primary host
  let url = `https://fantasy.espn.com${path}?${views}`;
  let r = await fetch(url, { headers: makeHeaders(), cache: "no-store", redirect: "follow" });
  let ct = r.headers.get("content-type") || "";
  let txt = await r.text();
  if (r.ok && ct.includes("application/json")) {
    try { return JSON.parse(txt); } catch {}
  }

  // Fallback host (read-optimized)
  url = `https://lm-api-reads.fantasy.espn.com${path}?${views}`;
  r = await fetch(url, { headers: makeHeaders(), cache: "no-store", redirect: "follow" });
  ct = r.headers.get("content-type") || "";
  txt = await r.text();
  if (r.ok && ct.includes("application/json")) {
    try { return JSON.parse(txt); } catch {}
  }

  // If still HTML or parse failed, return diagnostic
  throw new Error(`ESPN non-JSON response (${r.status}). ct=${ct}; body=${txt.slice(0, 300)}`);
}

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId");
    const season = Number(u.searchParams.get("season") || new Date().getUTCFullYear());
    if (!leagueId) return badRequest("leagueId required", 400);

    const { SWID, S2 } = extractAuthBits(request);
    if (!SWID || !S2) {
      return badRequest("Missing ESPN auth. Send X-ESPN-SWID (with braces) and X-ESPN-S2 from the browser.", 401);
    }
    const cookieHeader = `SWID=${SWID}; espn_s2=${S2}`;

    const data = await fetchEspnLeagueJson({ leagueId, season, cookieHeader });
    const members = buildMemberMap(data.members || []);
    const teamsIn = Array.isArray(data.teams) ? data.teams : [];

    const teams = teamsIn.map(t => {
      const rec = t?.record?.overall || {};
      const owners = Array.isArray(t?.owners) ? t.owners : [];
      const ownerName = owners.map(id => members.get(String(id))).find(Boolean) || owners[0] || "";
      return {
        teamId: Number(t?.id ?? t?.teamId),
        teamLocation: t?.location ?? t?.teamLocation ?? "",
        teamNickname: t?.nickname ?? t?.teamNickname ?? "",
        teamName: teamDisplayName(t),
        abbrev: t?.abbrev ?? t?.abbreviation ?? "",
        logo: t?.logo || "",
        owner: ownerName,
        wins: Number(rec?.wins ?? 0),
        losses: Number(rec?.losses ?? 0),
        ties: Number(rec?.ties ?? 0),
        pointsFor: Number(rec?.pointsFor ?? rec?.points ?? 0),
        pointsAgainst: Number(rec?.pointsAgainst ?? 0),
      };
    }).filter(t => Number.isFinite(t.teamId));

    teams.sort((a,b)=> a.teamId - b.teamId);
    return json({ ok: true, leagueId: String(leagueId), season, teams });
  } catch (err) {
    return json({ error: "ESPN fetch failed", detail: String(err?.message || err) }, 502);
  }
};
