// functions/api/oppsched.js
// GET /api/oppsched?leagueId=...&teamId=...&season=...&debug=1
// Always returns JSON; never HTML.

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function textPreview(s, n = 1000) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function normSWID(s) {
  if (!s) return "";
  const t = s.trim();
  if (!t) return "";
  const bare = t.replace(/^\{|\}$/g, "");
  return `{${bare}}`;
}

function readCookiePair(cookie, key) {
  // Very forgiving cookie parser; returns "" if not found
  try {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

function buildTeamName(team) {
  const id = team?.id ?? team?.teamId;
  const location = (team?.location || "").trim();
  const nickname = (team?.nickname || "").trim();
  const name = (team?.name || "").trim();
  const locNick = [location, nickname].filter(Boolean).join(" ").trim();
  const best = locNick || name || (id != null ? `Team ${id}` : "Team");
  return best;
}

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId") || u.searchParams.get("league");
    const teamIdStr = u.searchParams.get("teamId") || u.searchParams.get("team");
    const season = Number(u.searchParams.get("season") || new Date().getUTCFullYear());
    const debug = u.searchParams.get("debug");
    const teamId = teamIdStr != null ? Number(teamIdStr) : null;

    // Route sanity / debug mode
    if (debug === "1") {
      return json({
        ok: true,
        debug: true,
        message: "Routed to /api/oppsched (debug mode: no ESPN call).",
        leagueId: leagueId ?? null,
        teamId,
        season
      });
    }

    // Validate inputs
    if (!leagueId || teamId == null || Number.isNaN(teamId) || !season) {
      return json(
        { ok: false, error: "leagueId, teamId, and season are required." },
        400
      );
    }

    // ---- Auth: headers first, then cookies fallback (for your own domain)
    const h = request.headers;
    let swid = h.get("x-espn-swid") || "";
    let s2 = h.get("x-espn-s2") || "";

    const cookie = h.get("cookie") || "";
    if (!swid) swid = readCookiePair(cookie, "SWID");
    if (!s2) s2 = readCookiePair(cookie, "espn_s2") || readCookiePair(cookie, "ESPN_S2"); // handle alt casing

    swid = normSWID(swid);

    // Build ESPN URL
    const espnURL = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encodeURIComponent(
      leagueId
    )}?view=mMatchup&view=mTeam`;

    // Construct headers for ESPN
    const espnHeaders = {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 FortifiedFantasy",
      "x-fantasy-platform": "kona-PROD",
      "x-fantasy-source": "kona"
    };

    // Attach cookies if we have them (private leagues)
    const needCookies = Boolean(swid && s2);
    const fetchInit = {
      method: "GET",
      redirect: "manual", // surface redirects (auth wall) instead of auto-follow
      headers: {
        ...espnHeaders,
        ...(needCookies ? { cookie: `SWID=${swid}; espn_s2=${s2}` } : {})
      }
    };

    // Call ESPN
    const r = await fetch(espnURL, fetchInit);

    // If ESPN redirects (e.g., 302->sign-in), treat as auth required
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      // Headers used? If not, hint about passing SWID/espn_s2
      if (!needCookies) {
        return json(
          {
            ok: false,
            error: "Missing ESPN auth cookies.",
            hint:
              "Pass SWID (with braces) and espn_s2 via headers x-espn-swid / x-espn-s2."
          },
          401
        );
      }
      return json({ ok: false, error: "ESPN requires auth (redirected to sign-in)." }, 401);
    }

    // If non-OK from ESPN, surface detailed error
    if (!r.ok) {
      const details = await r.text().catch(() => "");
      return json(
        {
          ok: false,
          error: `ESPN error ${r.status}`,
          details: textPreview(details, 1000)
        },
        r.status >= 400 && r.status < 600 ? r.status : 502
      );
    }

    // Must be JSON
    const ct = r.headers.get("content-type") || "";
    const isJSON = ct.toLowerCase().includes("application/json");
    const raw = await r.text();
    if (!isJSON) {
      return json(
        {
          ok: false,
          error: "Unexpected non-JSON from ESPN (likely auth wall).",
          status: r.status,
          preview: textPreview(raw, 1000)
        },
        502
      );
    }

    // Parse league
    let league;
    try {
      league = JSON.parse(raw);
    } catch (e) {
      return json(
        {
          ok: false,
          error: "Failed to parse JSON from ESPN.",
          details: e?.message || String(e)
        },
        502
      );
    }

    // Extract weekCount
    const weekCount =
      Number(
        league?.settings?.scheduleSettings?.matchupPeriodCount ??
          league?.settings?.scheduleSettings?.matchupPeriodIds?.length
      ) || 14;

    // Teams list
    const teams = Array.isArray(league?.teams)
      ? league.teams.map((t) => ({
          teamId: t?.id ?? t?.teamId ?? null,
          teamName: buildTeamName(t),
          logo: t?.logo ?? null
        }))
      : [];

    // Build a map for teamId -> name (for opponentTeamName convenience)
    const nameById = new Map(teams.map((t) => [t.teamId, t.teamName]));

    // Initialize weeks with null opponents
    const weeks = Array.from({ length: weekCount }, (_, i) => ({
      week: i + 1,
      opponentTeamId: null,
      opponentTeamName: null
    }));

    // Walk schedule and fill opponent per week
    const sched = Array.isArray(league?.schedule) ? league.schedule : [];
    for (const g of sched) {
      const week = Number(g?.matchupPeriodId || g?.matchupId || g?.id);
      if (!week || week < 1 || week > weekCount) continue;

      // ESPN schemas sometimes offer both shapes; handle both.
      const homeTeamId =
        g?.home?.teamId ?? g?.homeTeamId ?? g?.home?.id ?? g?.homeId ?? null;
      const awayTeamId =
        g?.away?.teamId ?? g?.awayTeamId ?? g?.away?.id ?? g?.awayId ?? null;

      if (homeTeamId == null && awayTeamId == null) continue;

      if (homeTeamId === teamId) {
        const oppId = awayTeamId ?? null;
        weeks[week - 1].opponentTeamId = oppId;
        weeks[week - 1].opponentTeamName = oppId != null ? nameById.get(oppId) ?? null : null;
      } else if (awayTeamId === teamId) {
        const oppId = homeTeamId ?? null;
        weeks[week - 1].opponentTeamId = oppId;
        weeks[week - 1].opponentTeamName = oppId != null ? nameById.get(oppId) ?? null : null;
      }
      // If neither side matches teamId, ignore
    }

    // Done
    return json({
      ok: true,
      leagueId: String(leagueId),
      teamId,
      season,
      weekCount,
      weeks,
      teams
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "Internal error in /api/oppsched.",
        details: err?.message || String(err)
      },
      500
    );
  }
};
