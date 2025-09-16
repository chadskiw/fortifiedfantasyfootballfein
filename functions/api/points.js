// functions/api/points.js
// Fortified Fantasy — Weekly points (uses LEAGUE SCORING via ESPN applied totals)
//
// GET /api/points?leagueId=&teamId=&season=&week=
// - leagueId: defaults to your league (1888700373) if not provided
// - season: required (e.g., 2025)
// - teamId: optional (if omitted, tries to infer from SWID owner match)
// - week: required scoringPeriodId (1–18)
//
// Behavior
// - Fetch mBoxscore for (leagueId, season, scoringPeriodId=week)
// - Pull each roster entry's appliedStatTotal (already using *league's* scoring)
// - Return starters list + startersTotal
//
// Notes
// - We consider starters = lineupSlotId NOT in {20 (Bench), 21 (IR)}
// - Reactions given is not on ESPN; we keep a placeholder 0 (hook in later if stored server-side)

const DEFAULT_LEAGUE = "1888700373";

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

function buildBoxscoreUrl({ leagueId, season, week }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const qs = new URLSearchParams();
  qs.set("view", "mBoxscore");
  qs.set("scoringPeriodId", String(week));
  return `${base}?${qs.toString()}`;
}

function buildTeamsUrl({ leagueId, season }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const qs = new URLSearchParams();
  qs.set("view", "mTeam");
  return `${base}?${qs.toString()}`;
}

function isStarterSlot(lineupSlotId) {
  const id = Number(lineupSlotId);
  // 20=Bench, 21=IR. Everything else counts as “starter” (QB/RB/WR/TE/FLEX/K/DST/etc).
  return id !== 20 && id !== 21 && id >= 0;
}

function appliedForEntry(e, week) {
  // In mBoxscore, player stats per scoring period are in e.playerPoolEntry.appliedStatTotal (already applied)
  // Some payloads also expose appliedStats[<period>] — but appliedStatTotal is the per-entry summed total for that period.
  const total = e?.playerPoolEntry?.appliedStatTotal;
  if (Number.isFinite(total)) return Number(total);
  // Fallback: try per-period bucket
  const as = e?.playerPoolEntry?.appliedStats;
  if (as && as[String(week)] != null && Number.isFinite(as[String(week)])) {
    return Number(as[String(week)]);
  }
  return 0;
}

function flattenRosterFromBoxscore(data, teamId) {
  // mBoxscore includes schedule[].home/away{ teamId, rosterForCurrentScoringPeriod: { entries: [...] } }
  const schedule = Array.isArray(data?.schedule) ? data.schedule : [];
  const entries = [];
  for (const m of schedule) {
    for (const side of ["home", "away"]) {
      const obj = m?.[side];
      if (!obj || Number(obj.teamId) !== Number(teamId)) continue;
      const r = obj?.rosterForCurrentScoringPeriod?.entries || [];
      entries.push(...r);
    }
  }
  return entries;
}

function summarizeStarters(entries, week) {
  const starters = [];
  let total = 0;
  for (const e of entries) {
    const slot = e?.lineupSlotId;
    if (!isStarterSlot(slot)) continue;
    const pid = e?.playerPoolEntry?.id;
    const pts = appliedForEntry(e, week);
    starters.push({ playerId: pid, points: pts });
    total += pts;
  }
  return { starters, startersTotal: Number(total.toFixed(2)) };
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
    // owners can be array of SWID-like ids or objects; normalize to strings
    for (const o of (t.owners || [])) {
      const oid = (typeof o === "string" ? o : (o?.id || o?.owner || o?.displayName || "")).toString().toUpperCase();
      if (oid && oid.includes(needle.replace(/[{}]/g, ""))) {
        return t.id;
      }
    }
  }
  return null;
}

export async function onRequestGet({ request }) {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId") || DEFAULT_LEAGUE;
    const season   = u.searchParams.get("season");
    const week     = u.searchParams.get("week");

    if (!season || !week) {
      return json({ ok: false, error: "Missing required query params: season, week", hint: "e.g. /api/points?season=2025&week=1" }, 400);
    }

    const { swid, s2 } = readEspnAuth(request, request.url);
    if (!swid || !s2) {
      return json({ ok: false, error: "Not linked. ESPN auth missing.", need: ["x-espn-swid","x-espn-s2"] }, 401);
    }

    let teamId = u.searchParams.get("teamId");
    if (!teamId) {
      teamId = await findMyTeamId({ leagueId, season, swid, s2 });
      if (!teamId) return json({ ok: false, error: "Unable to infer teamId from SWID owners.", leagueId, season }, 404);
    }

    // Pull boxscore for the week (applied totals = already using *league scoring*)
    const boxUrl = buildBoxscoreUrl({ leagueId, season, week });
    const bs = await fetchJson(boxUrl, {
      headers: {
        "accept": "application/json",
        "cookie": `espn_s2=${s2}; SWID=${swid}`,
        "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0"
      }
    });
    if (!bs.ok) {
      return json({ ok: false, error: "Upstream ESPN error for boxscore", status: bs.status, upstream: bs.data }, 502);
    }

    const entries = flattenRosterFromBoxscore(bs.data, teamId);
    const sum = summarizeStarters(entries, Number(week));

    return json({
      ok: true,
      leagueId: String(leagueId),
      team_id: Number(teamId),
      season: Number(season),
      week: Number(week),
      startersTotal: sum.startersTotal,
      starters: sum.starters,
      reactionsGiven: 0 // placeholder until we wire your reactions store
    }, 200, { "x-ff-source": "points-applied" });

  } catch (err) {
    return json({ ok: false, error: "Unhandled exception in /api/points", detail: String(err?.message || err) }, 500);
  }
}
