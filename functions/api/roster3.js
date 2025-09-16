// functions/api/roster.js
// Fortified Fantasy — Roster (uses logged-in player by default)
// GET /api/roster?leagueId=&teamId=&season=

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) return { ok: false, status: res.status, data };
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: res.status, data: text.slice(0, 2000) };
  }
}

function readEspnAuth(request, url) {
  const h = request.headers;
  let swid = h.get("x-espn-swid") || "";
  let s2   = h.get("x-espn-s2")   || "";

  const cookie = h.get("cookie") || "";
  if (!swid) {
    const m = cookie.match(/SWID=([^;]+)/i);
    swid = m ? decodeURIComponent(m[1]) : swid;
  }
  if (!s2) {
    const m = cookie.match(/(?:^|;\s*)espn_s2=([^;]+)/i);
    s2 = m ? decodeURIComponent(m[1]) : s2;
  }

  const u = new URL(url);
  if (!swid) swid = u.searchParams.get("swid") || "";
  if (!s2)   s2   = u.searchParams.get("espn_s2") || "";

  if (swid && !/^\{.*\}$/.test(swid)) swid = "{" + swid.replace(/^\{|\}$/g, "") + "}";
  return { swid, s2 };
}

function buildTeamsUrl({ leagueId, season }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const qs = new URLSearchParams();
  qs.set("view", "mTeam");
  return `${base}?${qs.toString()}`;
}

// Team-scoped roster
function buildRosterUrl({ leagueId, season, teamId }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/teams/${teamId}`;
  const qs = new URLSearchParams();
  qs.set("view", "mRoster");
  return `${base}?${qs.toString()}`;
}

/* ---------- Correct lineup slot names (from lineupSlotId) ----------

Common ESPN FFL lineupSlotId values:
  0: QB
  2: RB
  3: RB/WR
  4: WR
  5: WR/TE
  6: TE
  7: OP         (Offensive Player / Superflex)
 16: D/ST
 17: K
 18: P
 19: HC
 20: BE         (Bench)
 21: IR
 23: FLEX       (RB/WR/TE)

Only starters are < 18 (per your rule). Bench/IR are 20/21.
------------------------------------------------------------------- */
function slotNameFromLineup(id) {
  const M = {
    0: "QB",
    2: "RB",
    3: "RB/WR",
    4: "WR",
    5: "WR/TE",
    6: "TE",
    7: "OP",
    16: "D/ST",
    17: "K",
    18: "P",
    19: "HC",
    20: "BE",
    21: "IR",
    23: "FLEX"
  };
  return M[Number(id)] ?? `SLOT_${id}`;
}

async function findMyTeamId({ leagueId, season, swid, s2 }) {
  const url = buildTeamsUrl({ leagueId, season });
  const res = await fetchJson(url, {
    headers: {
      "accept": "application/json",
      "cookie": `espn_s2=${s2}; SWID=${swid}`,
      "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0"
    }
  });
  if (!res.ok) return null;
  const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
  const needle = String(swid || "").toUpperCase();
  for (const t of teams) {
    for (const o of (t.owners || [])) {
      const oid = (typeof o === "string" ? o : (o?.id || o?.owner || o?.displayName || "")).toString().toUpperCase();
      if (oid && oid.includes(needle.replace(/[{}]/g, ""))) return t.id;
    }
  }
  return null;
}

function normalizeRoster(data) {
  const entries = Array.isArray(data?.roster?.entries) ? data.roster.entries : [];
  const starters = [];
  const bench = [];

  for (const e of entries) {
    const pp = e?.playerPoolEntry || {};
    const p  = pp?.player || {};
    const slotId = Number(e?.lineupSlotId);
    const out = {
      id:                pp.id,
      fullName:          p.fullName || p.name,
      defaultPositionId: p.defaultPositionId,     // keep for reference
      proTeamId:         p.proTeamId,
      slotId,                                      // CORRECT: lineup slot id
      slotName:          slotNameFromLineup(slotId) // CORRECT: lineup slot name
    };
    // Starters are strictly < 18 per your UI logic
    if (slotId < 18 && slotId >= 0) starters.push(out);
    else bench.push(out); // includes BE(20) / IR(21) / FLEX(23) / etc.
  }

  return { starters, bench };
}

export async function onRequestGet({ request }) {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId");
    const season   = u.searchParams.get("season");
    let teamId     = u.searchParams.get("teamId");

    if (!leagueId || !season) {
      return json({ ok: false, error: "Missing required query params: leagueId, season" }, 400);
    }

    const { swid, s2 } = readEspnAuth(request, request.url);
    if (!swid || !s2) {
      return json({ ok: false, error: "Not linked. ESPN auth missing.", need: ["x-espn-swid","x-espn-s2"] }, 401);
    }

    if (!teamId) {
      teamId = await findMyTeamId({ leagueId, season, swid, s2 });
      if (!teamId) return json({ ok: false, error: "Unable to infer teamId from SWID owners.", leagueId, season }, 404);
    }

    const url = buildRosterUrl({ leagueId, season, teamId });
    const r = await fetchJson(url, {
      headers: {
        "accept": "application/json",
        "cookie": `espn_s2=${s2}; SWID=${swid}`,
        "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0"
      }
    });
    if (!r.ok) {
      return json({ ok: false, error: "Upstream ESPN error for roster", status: r.status, upstream: r.data }, 502);
    }

    const shaped = normalizeRoster(r.data || {});
    return json({ ok: true, leagueId, teamId: Number(teamId), season: Number(season), ...shaped }, 200, { "x-ff-source": "roster-mine" });

  } catch (err) {
    return json({ ok: false, error: "Unhandled exception in /api/roster", detail: String(err?.message || err) }, 500);
  }
}
