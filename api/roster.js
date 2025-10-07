/**
 * getEspnRoster
 * Server-side helper you can import from other server files.
 * Returns the same shapes your route returns (one team or league-wide).
 *
 * @param {Object} params
 * @param {string|number} params.leagueId
 * @param {number} params.season
 * @param {number|undefined} params.week
 * @param {string|undefined} params.teamId
 * @param {string} params.swid   // normalized {GUID} or empty
 * @param {string} params.s2     // espn_s2 or empty
 * @returns {Promise<{ ok: boolean } & object>}
 */
export async function getEspnRoster({ leagueId, season, week, teamId, swid, s2 }) {
  if (!leagueId) return { ok:false, error:'Missing leagueId' };
  if (!Number.isFinite(season) || season < 2000) return { ok:false, error:'Invalid season' };
  if (week != null && (!Number.isFinite(week) || week < 0)) return { ok:false, error:'Invalid week' };

  // Build headers once
  const headers = {
    cookie: (swid && s2) ? `SWID=${swid}; espn_s2=${s2}` : '',
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
    if (res.ok && res.data) { upstream = res; break; }
  }

  if (!upstream?.ok || !upstream?.data) {
    return {
      ok: false,
      error: "Upstream ESPN error",
      status: upstream?.status ?? 502,
      upstream: upstream?.data ?? upstream?.raw ?? null,
      attempts,
    };
  }

  const blob = upstream.data || {};
  const rawTeams = Array.isArray(blob?.teams) ? blob.teams : [];

  if (teamId) {
    const t = rawTeams.find((tt) => String(tt?.id) === String(teamId));
    if (!t) {
      return {
        ok: false,
        error: `Team ${teamId} not found in league ${leagueId}`,
        teamsReturned: rawTeams.length,
      };
    }
    const one = normalizeOneTeam(t);
    return {
      ok: true,
      platform: "espn",
      leagueId: String(leagueId),
      season: Number(season),
      week: week ?? null,
      teamId: one.teamId,
      team_name: one.team_name,
      players: one.players,
      meta: { attempts },
    };
  }

  // league-wide
  const teams = rawTeams.map(normalizeOneTeam);
  return {
    ok: true,
    platform: "espn",
    leagueId: String(leagueId),
    season: Number(season),
    week: week ?? null,
    teams,
    meta: { attempts },
  };
}
