// functions/api/platforms/espn/teams.js
// GET /api/platforms/espn/teams?season=2025&leagueId=1888700373
// => { ok, leagueId, season, teamCount, teams:[{ teamId, teamName, ownerName, logoUrl }], meta }

const THIS_YEAR = new Date().getUTCFullYear();

/* -------------------------- cookie/header helpers -------------------------- */
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
function getHeader(h, name) { return h.get(name) || h.get(name.toLowerCase()) || h.get(name.toUpperCase()); }
function normalizeSwid(swidRaw = "") {
  const s = String(swidRaw || "").trim();
  if (!s) return "";
  return /^\{.*\}$/.test(s) ? s : `{${s.replace(/^\{|\}$/g, "")}}`;
}
async function resolveCreds(request) {
  const headers = request.headers;
  const cookieHeader = headers.get("cookie") || "";
  const c = readCookies(cookieHeader);

  let SWID = getHeader(headers, "X-ESPN-SWID") || c.SWID || "";
  let s2   = getHeader(headers, "X-ESPN-S2")   || c.espn_s2 || "";

  SWID = normalizeSwid(SWID);
  s2   = String(s2 || "").trim();

  // Optional: same-origin creds endpoint
  if (!SWID || !s2) {
    try {
      const base = new URL(request.url).origin;
      const u = new URL("/api/espn-auth/creds", base);
      const r = await fetch(u.toString(), { headers: { accept: "application/json" }, credentials: "include" });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) {
          SWID ||= normalizeSwid(j.SWID || j.swid || "");
          s2   ||= String(j.s2 || j.espn_s2 || "").trim();
        }
      }
    } catch {}
  }
  return { SWID, s2, hasAuth: Boolean(SWID && s2) };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/* ----------------------------- fetch utilities ----------------------------- */
function abortAfter(ms) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort("timeout"), ms);
  return { signal: ctl.signal, cancel: () => clearTimeout(id) };
}
async function fetchJson(url, opts = {}, timeoutMs = 9000) {
  const { signal, cancel } = abortAfter(timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, data, bodyPreview: (text || "").slice(0, 200) };
  } finally { cancel(); }
}

/* ------------------------------ ESPN requests ------------------------------ */
function espnHeaders({ SWID, s2 }) {
  const h = {
    accept: "application/json",
    referer: "https://www.espn.com/",
    "user-agent": "FortifiedFantasy/1.0 (+cloudflare-pages)",
    "cache-control": "no-cache",
    "x-fantasy-platform": "kona",
    "x-fantasy-source":   "kona",
  };
  if (SWID || s2) h.cookie = `SWID=${SWID || ""}; espn_s2=${s2 || ""}`;
  return h;
}

// ESPN sometimes returns an array; normalize to a single league object.
function firstLeagueObject(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  return payload && typeof payload === "object" ? payload : null;
}

function mapTeams(league) {
  const teams   = Array.isArray(league?.teams)   ? league.teams   : [];
  const members = Array.isArray(league?.members) ? league.members : [];

  const ownerNameById = {};
  for (const m of members) {
    const id = String(m?.id ?? "");
    const dn = m?.displayName || ((m?.firstName || "") + " " + (m?.lastName || "")).trim();
    if (id) ownerNameById[id] = dn || id;
  }

  return teams.map((t) => {
    const teamId = Number(t?.id ?? 0);
    const name =
      (t?.location || t?.nickname) ? `${t.location || ""} ${t.nickname || ""}`.trim() :
      (t?.name || `Team ${teamId}`);
    const primaryOwner = String(t?.primaryOwner ?? "");
    const owners = Array.isArray(t?.owners) && t.owners.length ? t.owners.map(String) : (primaryOwner ? [primaryOwner] : []);
    const ownerName = owners.map((id) => ownerNameById[id] || id).join(", ");
    const logo = t?.logo || t?.logoURL || "";

    return {
      teamId: String(teamId),
      teamName: name || "Team",
      ownerName: ownerName || "—",
      logoUrl: logo,
    };
  });
}

/* Try multiple upstreams and stop at the first that yields teams */
async function loadLeagueWithFallbacks({ season, leagueId, SWID, s2 }) {
  const headers = espnHeaders({ SWID, s2 });
  const attempts = [
    {
      label: "lm-api-reads mTeam+mSettings+mMembers",
      url: `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings&view=mMembers`,
    },
    {
      label: "fantasy.espn.com mTeam+mSettings+mMembers",
      url: `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings&view=mMembers`,
    },
    {
      label: "leagueHistory mTeam+mSettings+mMembers",
      url: `https://fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${leagueId}?seasonId=${season}&view=mTeam&view=mSettings&view=mMembers`,
    },
    {
      label: "mTeam scoringPeriodId=1",
      url: `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&scoringPeriodId=1`,
    },
    {
      label: "modular",
      url: `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=modular`,
    },
  ];

  const upstream = [];
  for (const a of attempts) {
    const res = await fetchJson(a.url, { headers }, 10000);
    const league = firstLeagueObject(res.data);
    const teams = league ? mapTeams(league) : [];
    upstream.push({
      label: a.label,
      status: res.status,
      ok: res.ok,
      teamsFound: teams.length,
      membersCount: Array.isArray(league?.members) ? league.members.length : 0,
      settingsSize: Number(league?.settings?.size || 0),
      bodyPreview: !res.ok ? res.bodyPreview : undefined,
    });
    if (teams.length) {
      return { league, teams, upstream };
    }
  }
  return { league: null, teams: [], upstream };
}

/* --------------------------------- handler --------------------------------- */
export async function onRequestGet({ request }) {
  try {
    const u = new URL(request.url);
    const season   = Number(u.searchParams.get("season")) || THIS_YEAR;
    const leagueId = (u.searchParams.get("leagueId") || "").trim();

    if (!leagueId) return json({ ok: false, error: "Missing leagueId." }, 400);
    if (!Number.isFinite(season) || season < 2000) return json({ ok: false, error: "Bad season." }, 400);

    const { SWID, s2, hasAuth } = await resolveCreds(request);

    const { league, teams, upstream } = await loadLeagueWithFallbacks({ season, leagueId, SWID, s2 });
    const teamCount = teams.length || Number(league?.settings?.size || 0);

    return json({
      ok: true,
      leagueId: String(leagueId),
      season: Number(season),
      teamCount,
      teams,
      meta: {
        hasAuth,
        swidPresent: !!SWID,
        s2Present: !!s2,
        upstream, // <— shows which attempt(s) returned data or failed
      },
    });
  } catch (err) {
    return json({
      ok: false,
      error: "Unhandled exception in /api/platforms/espn/teams",
      detail: String(err && err.stack ? err.stack : err),
    }, 500);
  }
}
