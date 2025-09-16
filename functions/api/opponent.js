// functions/api/opponent.js
// Fortified Fantasy — Opponent Lookup (NFL team vs team for a given fantasy week)
//
// Usage:
//   GET /api/opponent?leagueId=1888700373&season=2025&week=1&teamAbbr=ARI
// Response:
//   { ok:true, teamAbbr:"ARI", week:1, opponent:"BUF" }

function json(body, status = 200, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "charset": "utf-8",
    // CORS so you can call this from anywhere
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type"
  };
  for (const [k, v] of Object.entries(extraHeaders || {})) headers[k] = v;
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

const TEAM_NORM = { JAC:"JAX", WAS:"WSH", OAK:"LV", SD:"LAC", STL:"LAR", LA:"LAR" };
const normTeam = (abbr) => TEAM_NORM[String(abbr || "").toUpperCase()] || String(abbr || "").toUpperCase();

// Simple week guard: fantasy regular-season weeks are 1–18
const safeWeek = (w) => {
  const n = Number(w);
  return Number.isInteger(n) && n >= 1 && n <= 18 ? n : null;
};

export const onRequestOptions = async () => {
  // Preflight for CORS
  return json({ ok: true });
};

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId"); // not used, but accepted for parity
    const season   = Number(u.searchParams.get("season"));
    const week     = safeWeek(u.searchParams.get("week"));
    const teamAbbr = normTeam(u.searchParams.get("teamAbbr") || "");

    if (!season || !week || !teamAbbr) {
      return json({ ok:false, error:"Missing or invalid season, week, or teamAbbr" }, 400);
    }

    // Regular season = seasontype 2
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
    const res = await fetch(url, { headers: { "accept": "application/json" } });

    if (!res.ok) {
      return json({ ok:false, error:"Upstream error", status: res.status }, 502);
    }

    const data = await res.json().catch(() => null);
    const events = data?.events;
    if (!Array.isArray(events) || events.length === 0) {
      // If no games are listed for this week (rare), treat as schedule missing.
      return json({ ok:false, error:`No NFL events found for season ${season} week ${week}` }, 502);
    }

    // Search events for one involving teamAbbr
    let opponent = null;

    for (const ev of events) {
      const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
      const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];

      // competitors has objects with .team.abbreviation
      const hasTeam = competitors.find(c => normTeam(c?.team?.abbreviation) === teamAbbr);
      if (hasTeam) {
        const opp = competitors.find(c => normTeam(c?.team?.abbreviation) !== teamAbbr);
        const oppAbbr = normTeam(opp?.team?.abbreviation);
        if (oppAbbr) {
          opponent = oppAbbr;
          break;
        }
      }
    }

    // If we didn't find the team in any event that week, it's a BYE
    if (!opponent) {
      return json({ ok:true, teamAbbr, week, opponent: "BYE" }, 200);
    }

    return json({ ok:true, teamAbbr, week, opponent }, 200);
  } catch (err) {
    return json({ ok:false, error:"Unhandled exception", detail:String(err && err.stack || err) }, 500);
  }
};
