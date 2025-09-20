CHECK THIS OUT
// TRUE_LOCATION: api/platforms/espn/roster.js
// IN_USE: FALSE
// GET  /api/platforms/espn/roster?season=2025&leagueId=...&week=1[&teamId=4]
// 200 + data on success
// 401 with { ok:false, error:'auth_required', ... } when SWID/espn_s2 are missing

const THIS_YEAR = new Date().getUTCFullYear();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type, X-ESPN-SWID, X-ESPN-S2",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

/* --------------------- utils --------------------- */
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
function getHeader(h, name) {
  return h.get(name) || h.get(name.toLowerCase()) || h.get(name.toUpperCase());
}
function normalizeSwid(swidRaw = "") {
  const s = String(swidRaw || "").trim();
  if (!s) return "";
  return /^\{.*\}$/.test(s) ? s : `{${s.replace(/^\{|\}$/g, "")}}`;
}
function creds(req, urlStr) {
  const c = readCookies(req.headers.get("cookie") || "");
  let swid = (getHeader(req.headers, "X-ESPN-SWID") || c.SWID || "").trim();
  let s2   = (getHeader(req.headers, "X-ESPN-S2")   || c.espn_s2 || "").trim();

  // allow query overrides for debugging
  const u = new URL(urlStr);
  if (!swid) swid = (u.searchParams.get("swid") || "").trim();
  if (!s2)   s2   = (u.searchParams.get("s2") || u.searchParams.get("espn_s2") || "").trim();

  // normalize SWID to {GUID} form
  swid = swid ? normalizeSwid(swid) : "";

  return { swid, s2 };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, ...extra },
  });
}
async function fetchJson(url, opts, timeoutMs = 10000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort("timeout"), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, data, raw: data ? null : text.slice(0, 500) };
  } finally {
    clearTimeout(id);
  }
}

/* --------------------- ESPN --------------------- */
function espnLeagueUrlRead({ leagueId, season, week }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const q = new URLSearchParams();
  q.append("view", "mRoster");
  q.append("view", "mTeam");
  if (week != null) q.set("scoringPeriodId", String(week));
  return `${base}?${q.toString()}`;
}
function espnLeagueUrlStd({ leagueId, season, week }) {
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const q = new URLSearchParams();
  q.append("view", "mRoster");
  q.append("view", "mTeam");
  if (week != null) q.set("scoringPeriodId", String(week));
  return `${base}?${q.toString()}`;
}

const SLOT = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "BE", 21: "IR",
  23: "FLEX", 24: "WR/RB", 25: "WR/TE", 26: "QB/RB/WR/TE", 27: "OP",
};
const PROTEAM = {
  0:"FA",1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",
  9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",
  17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",
  25:"SF",26:"SEA",27:"TB",28:"WSH",29:"CAR",30:"JAX",33:"BAL",34:"HOU"
};
function safeTrim(s){ return (s == null) ? "" : String(s).trim(); }
function teamDisplayName(t) {
  const parts = [
    safeTrim(t.name),
    safeTrim(`${t.location ?? ""} ${t.nickname ?? ""}`),
    safeTrim(t.teamName), safeTrim(t.nickname), safeTrim(t.location),
    safeTrim(t.abbrev),
  ].filter(Boolean);
  return parts[0] || `Team ${t?.id ?? ""}`;
}
function normalizeOneTeam(t) {
  const entries = Array.isArray(t?.roster?.entries) ? t.roster.entries : [];
  const players = entries.map((e) => {
    const p = e?.playerPoolEntry?.player || e?.player || {};
    const slotId = Number(e?.lineupSlotId ?? e?.lineupSlot ?? 20);
    const proTeam =
      p?.proTeamAbbreviation ||
      (Number.isFinite(+p?.proTeamId) ? PROTEAM[+p.proTeamId] : "") || "";
    const position =
      p?.defaultPosition || p?.primaryPosition ||
      (Number.isFinite(+p?.defaultPositionId) ? SLOT[+p.defaultPositionId] : "") || "";

    return {
      id: Number(p?.id || e?.playerId || 0) || null,
      name: p?.fullName || p?.name || "",
      position,
      team: proTeam,
      lineupSlot: SLOT[slotId] || String(slotId),
      status: p?.status || "",
      injury: p?.injuryStatus || "",
    };
  });
  return {
    teamId: String(t?.id ?? ""),
    team_name: teamDisplayName(t), // timeline expects 'team_name'
    players,
  };
}

/* --------------------- handler --------------------- */
export async function onRequestGet({ request }) {
  try {
    const url = new URL(request.url);
    const leagueId = (url.searchParams.get("leagueId") || "").trim();
    const season = Number(url.searchParams.get("season") || THIS_YEAR);
    const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : undefined;
    const teamId = url.searchParams.get("teamId");

    if (!leagueId) return json({ ok: false, error: "Missing leagueId" }, 400);
    if (!Number.isFinite(season) || season < 2000) return json({ ok: false, error: "Invalid season" }, 400);
    if (week != null && (!Number.isFinite(week) || week < 0)) {
      return json({ ok: false, error: "Invalid week" }, 400);
    }

    const { swid, s2 } = creds(request, request.url);
    if (!swid || !s2) {
      // Friendly 401 body your client can handle
      return json(
        {
          ok: false,
          error: "auth_required",
          message: "Log in with ESPN to view this league’s roster.",
          action: "open_auth_prompt",
          tips: [
            "We’ll never post to your ESPN account.",
            "We only need read access to your league data.",
          ],
        },
        401,
        {
          // Optional: hint for debuggers & tools
          "WWW-Authenticate": 'Bearer realm="espn", error="invalid_token"',
        }
      );
    }

    // Build headers once
    const headers = {
      cookie: `SWID=${swid}; espn_s2=${s2}`,
      accept: "application/json",
      referer: `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
      origin: "https://fantasy.espn.com",
      "user-agent": "FortifiedFantasy/1.0 (+cf-pages)",
      "x-fantasy-platform": "kona",
      "x-fantasy-source": "kona",
      "cache-control": "no-cache",
    };

    // Try read host first, then standard host
    const urls = [
      { label: "lm-api-reads", href: espnLeagueUrlRead({ leagueId, season, week }) },
      { label: "fantasy.espn.com", href: espnLeagueUrlStd({ leagueId, season, week }) },
    ];

    let upstream = null;
    const attempts = [];
    for (const u of urls) {
      const res = await fetchJson(u.href, { headers }, 12000);
      attempts.push({ host: u.label, status: res.status, ok: res.ok, hasData: !!res.data, bodyPreview: res.ok ? undefined : res.raw });
      if (res.ok && res.data) {
        upstream = res;
        break;
      }
    }

    if (!upstream?.ok || !upstream?.data) {
      return json(
        {
          ok: false,
          error: "upstream_failure",
          status: upstream?.status ?? 502,
          upstream: upstream?.data ?? upstream?.raw ?? null,
          attempts,
        },
        502
      );
    }

    const blob = upstream.data || {};
    const rawTeams = Array.isArray(blob?.teams) ? blob.teams : [];

    if (teamId) {
      const t = rawTeams.find((tt) => String(tt?.id) === String(teamId));
      if (!t)
        return json(
          {
            ok: false,
            error: `Team ${teamId} not found in league ${leagueId}`,
            teamsReturned: rawTeams.length,
          },
          404
        );
      const one = normalizeOneTeam(t);
      return json({
        ok: true,
        platform: "espn",
        leagueId: String(leagueId),
        season: Number(season),
        week: week ?? null,
        teamId: one.teamId,
        team_name: one.team_name,
        players: one.players,
        meta: { attempts },
      });
    }

    // league-wide
    const teams = rawTeams.map(normalizeOneTeam);
    return json({
      ok: true,
      platform: "espn",
      leagueId: String(leagueId),
      season: Number(season),
      week: week ?? null,
      teams,
      meta: { attempts },
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

export function onRequestOptions() {
  return new Response("", { status: 204, headers: CORS_HEADERS });
}
