// functions/api/bye-weeks.js
// Returns: { ok: true, season, leagueId, teamId, source, byeWeeks: { "BAL": 14, "BUF": 13, ... } }

const TEAM_ABBR = {
  // ESPN proTeamId -> NFL abbr
  1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",
  12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",
  22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WSH",29:"CAR",30:"JAX",33:"BAL",34:"HOU"
};

// Normalize team abbreviations seen in some payloads
function normAbbr(v) {
  const s = String(v || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (s === "JAC") return "JAX";
  if (s === "WAS") return "WSH";
  if (s === "SD")  return "LAC";
  if (s === "OAK") return "LV";
  if (s === "LA" || s === "STL") return "LAR";
  return s;
}

/* =========================
   ESPN players → bye map
   ========================= */
async function fetchEspnPlayers(season) {
  // ESPN Fantasy Football players endpoint (players_wl view carries byeWeek)
  // Use small scoringPeriodId to avoid huge payloads.
  const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}/players?scoringPeriodId=1&view=players_wl`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "FortifiedFantasy/1.0"
    }
  });
  if (!res.ok) throw new Error(`ESPN players ${res.status}`);
  return res.json();
}

function computeByeWeeksFromPlayers(players) {
  const hist = new Map(); // abbr -> Map(week -> count)
  for (const p of Array.isArray(players) ? players : []) {
    // common shapes: p.proTeamId, p.byeWeek; sometimes p.player?.byeWeek
    const teamId = p?.proTeamId ?? p?.player?.proTeamId;
    const week   = p?.byeWeek ?? p?.player?.byeWeek;
    const abbr   = TEAM_ABBR[teamId];
    const w      = Number(week);

    if (!abbr) continue;
    if (!Number.isInteger(w) || w < 1 || w > 18) continue;

    if (!hist.has(abbr)) hist.set(abbr, new Map());
    const m = hist.get(abbr);
    m.set(w, (m.get(w) || 0) + 1);
  }

  // Pick the mode per team
  const byeWeeks = {};
  for (const [abbr, m] of hist) {
    let bestW = null, bestC = -1;
    for (const [w, c] of m) {
      if (c > bestC) { bestC = c; bestW = w; }
    }
    if (bestW != null) byeWeeks[abbr] = bestW;
  }
  return byeWeeks;
}

/* =========================
   Fallback: ESPN scoreboard scan
   ========================= */
const NFL_TEAMS = [
  "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB",
  "HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ",
  "PHI","PIT","SEA","SF","TB","TEN","WSH"
];

async function fetchWeekTeams(season, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${encodeURIComponent(season)}&week=${week}&seasontype=2`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`scoreboard ${res.status} (w${week})`);
  const j = await res.json();

  const present = new Set();
  const events = Array.isArray(j?.events) ? j.events : [];
  for (const ev of events) {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    const teams = Array.isArray(comp?.competitors) ? comp.competitors : [];
    for (const t of teams) {
      const ab = normAbbr(t?.team?.abbreviation ?? t?.team?.abbrev ?? t?.team?.id);
      if (ab) present.add(ab);
    }
  }
  return present;
}

async function computeByeWeeksFromScoreboard(season) {
  const byeWeeks = {};
  const remaining = new Set(NFL_TEAMS);

  for (let wk = 1; wk <= 18; wk++) {
    if (remaining.size === 0) break;
    let present;
    try {
      present = await fetchWeekTeams(season, wk);
    } catch {
      // If a single week fails, keep going; we may still fill others.
      continue;
    }
    for (const team of [...remaining]) {
      if (!present.has(team)) {
        byeWeeks[team] = wk;
        remaining.delete(team);
      }
    }
  }
  // keep only 1..18 ints
  for (const [abbr, w] of Object.entries(byeWeeks)) {
    if (!Number.isInteger(w) || w < 1 || w > 18) delete byeWeeks[abbr];
  }
  return byeWeeks;
}

/* =========================
   Handler
   ========================= */
export async function onRequestGet({ request }) {
  try {
    const url      = new URL(request.url);
    const season   = url.searchParams.get("season") || String(new Date().getFullYear());
    const leagueId = url.searchParams.get("leagueId") || null;
    const teamId   = url.searchParams.get("teamId") || null;

    let source = "players";
    let byeWeeks = {};

    // 1) Preferred: players metadata (fast, direct)
    try {
      const players = await fetchEspnPlayers(season);
      byeWeeks = computeByeWeeksFromPlayers(players);
    } catch (e) {
      // 2) Fallback: scoreboard scan (robust if players API changes/rate-limits)
      source = "scoreboard";
      byeWeeks = await computeByeWeeksFromScoreboard(season);
    }

    // Final sanity: enforce only 1..18 ints & normalize keys
    const clean = {};
    for (const [abbrRaw, w] of Object.entries(byeWeeks)) {
      const abbr = normAbbr(abbrRaw);
      if (Number.isInteger(w) && w >= 1 && w <= 18 && abbr) clean[abbr] = w;
    }

    return new Response(JSON.stringify({
      ok: true,
      season,
      leagueId,
      teamId,
      source,
      byeWeeks: clean
    }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        // while iterating in dev, avoid CDN/browser caching:
        "cache-control": "no-store"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}
