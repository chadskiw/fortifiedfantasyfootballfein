// functions/api/teams.js
// Fortified Fantasy — Teams API (uses DB creds when browser lacks ESPN auth)
//
// GET /api/teams?leagueId=&season=
//
// Behavior:
// 1) Try to read x-espn-swid/x-espn-s2 from headers/cookies.
// 2) If missing, fetch SWID/espn_s2 for the league from your Render auth service.
// 3) Call ESPN league endpoint and normalize teams.
//
// Env/Constants:
// - API_BASE: base URL for your Render service (default below)

const API_BASE = ''; // same-origin
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/* ---------------------------- helpers / utilities ---------------------------- */

function teamDisplayName(t) {
  const candidates = [
    t.name,
    `${t.location ?? ""} ${t.nickname ?? ""}`,
    t.teamName,
    t.teamNickname,
    t.nickname,
    t.location,
    t.abbrev
  ].map(s => (s ?? "").toString().trim()).filter(Boolean);
  return candidates[0] || `Team ${t.id}`;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) {
      return { ok: false, status: res.status, error: "Non-200 from upstream", data };
    }
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: res.status, error: "Invalid JSON from upstream", data: text.slice(0, 1000) };
  }
}

// Read ESPN auth from headers/cookies/query; normalize SWID braces
// Read ESPN auth from headers/cookies/query; normalize SWID braces
// Read ESPN auth from headers/cookies/query; normalize SWID braces
function readEspnAuth(request, urlStr) {
  const url = new URL(urlStr);
  const h = request.headers;

  // headers (case-insensitive)
  let swid = h.get("X-ESPN-SWID") || h.get("x-espn-swid") || "";
  let s2   = h.get("X-ESPN-S2")   || h.get("x-espn-s2")   || "";

  // cookies (same-origin calls with credentials: 'include')
  const cookie = h.get("cookie") || "";
  if (!swid) swid = /(?:^|;\s*)SWID=([^;]+)/i.exec(cookie)?.[1] || "";
  if (!s2)   s2   = /(?:^|;\s*)espn_s2=([^;]+)/i.exec(cookie)?.[1] || "";

  // query params — accept BOTH ?s2= and ?espn_s2=
  if (!swid) swid = url.searchParams.get("swid") || "";
  if (!s2)   s2   = url.searchParams.get("s2") || url.searchParams.get("espn_s2") || "";

  // normalize SWID to {...}
  if (swid && !/^\{.*\}$/.test(swid)) swid = "{" + swid.replace(/^\{|\}$/g, "") + "}";

  return { swid, s2 };
}



// Server-to-server: ask Render for creds for this league
async function fetchLeagueCreds(leagueId, season) {
  const u = new URL(`${API_BASE}/fein-auth/creds`);
  u.searchParams.set("leagueId", String(leagueId));
  if (season) u.searchParams.set("season", String(season));
  const r = await fetchJson(u.toString(), {
    headers: { accept: "application/json" },
    // Optional: include a shared secret if your Render route requires it
    // headers: { accept: "application/json", "x-ff-internal": FF_INTERNAL_SECRET }
  });
  if (!r.ok) return { swid: "", s2: "" };
  const c = r.data || {};
  // expected shape: { ok:true, swid:"{...}", s2:"..." }  (adjust if your service differs)
  return { swid: c.swid || "", s2: c.s2 || c.espn_s2 || "" };
}

function buildEspnLeagueUrl({ leagueId, season=2025 }) {
  // League “meta+teams”. mTeam includes owners & names; add views as needed
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const params = new URLSearchParams();
  params.set("view", "mTeam");
  params.append("view", "mSettings");
  return `${base}?${params.toString()}`;
}

/* ------------------------------- main handler -------------------------------- */

export async function onRequestGet({ request }) {
  try {
    const url = new URL(request.url);
    const leagueId = url.searchParams.get("leagueId");
    const season   = url.searchParams.get("season") || url.searchParams.get("year");

    if (!leagueId || !season) {
      return json({ ok: false, error: "Missing required query params: leagueId, season" }, 400);
    }

    // 1) Try incoming auth
    let { swid, s2 } = readEspnAuth(request, request.url);

    // 2) If missing, pull from DB via Render
    if (!swid || !s2) {
      const creds = await fetchLeagueCreds(leagueId, season);
      swid = swid || creds.swid;
      s2   = s2   || creds.s2;
    }

    if (!swid || !s2) {
      // Still nothing — explain clearly to the frontend
      return json({ ok: false, error: "Not linked. No ESPN credentials found for this league.", leagueId, season }, 401);
    }

    // 3) Call ESPN
    const espnUrl = buildEspnLeagueUrl({ leagueId, season });
    const espn = await fetchJson(espnUrl, {
      headers: {
        "accept": "application/json",
        "cookie": `espn_s2=${s2}; SWID=${swid}`,
        "referer": `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
        "origin": "https://fantasy.espn.com",
        "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    if (!espn.ok) {
      return json({ ok: false, error: "Upstream (ESPN) error", status: espn.status, upstream: espn.data }, 502);
    }

    const data = espn.data || {};
    const rawTeams = Array.isArray(data?.teams) ? data.teams : [];

    // 4) Normalize teams
    const teams = rawTeams.map(t => {
      const id = t?.id;
      // try displayName from owners[] object if present
      let ownerName = "";
      if (Array.isArray(t?.owners) && t.owners.length) {
        const o = t.owners[0];
        if (o && typeof o === "object") {
          ownerName = o.displayName || o.firstName || "";
        } else if (typeof o === "string") {
          ownerName = o;
        }
      }
      const name  = teamDisplayName(t);
      const logo  = t?.logo || t?.logoURL || t?.logoUrl || "";

      return {
        id: String(id ?? ""),
        teamId: String(id ?? ""),      // frontend-friendly alias
        name,
        teamName: name,                // frontend-friendly alias
        owner: ownerName || "",
        logo
      };
    });

    // 5) Compute league size (settings or fallback to team count)
    const leagueSize =
      Number(data?.settings?.size) ||
      Number(data?.settings?.teamCount) ||
      (Array.isArray(rawTeams) ? rawTeams.length : null) ||
      null;

    return json(
      { ok: true, teams, meta: { leagueSize } },
      200,
      {
        "x-ff-source": "teams-with-db-auth",
        "x-ff-auth-saw": JSON.stringify({ hasSWID: !!swid, hasS2: !!s2 })
      }
    );

  } catch (err) {
    return json({ ok: false, error: "Unhandled exception in /api/teams", detail: String((err && err.stack) || err) }, 500);
  }
}

