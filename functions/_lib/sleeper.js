// functions/_lib/sleeper.js
import { THIS_YEAR, json, badRequest, upstreamFail } from "../_lib/http.js";

/*
  Sleeper does not require auth to list leagues by user.
  You can allow ?user=<usernameOrId> or read X-SLEEPER-USER header.

  GET https://api.sleeper.app/v1/user/<usernameOrId>   -> { user_id, username, ... }
  GET https://api.sleeper.app/v1/user/<user_id>/leagues/nfl/<season> -> [... leagues]
*/
export async function sleeperResolveUser(user) {
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(user)}`);
  if (!r.ok) throw new Error(`Sleeper user lookup ${r.status}`);
  return r.json(); // { user_id, username, ... }
}
export async function sleeperGetLeagues(userId, season) {
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`);
  if (!r.ok) throw new Error(`Sleeper leagues ${r.status}`);
  return r.json();
}
export function sleeperMapLeagues(arr = []) {
  return arr.map(l => ({
    leagueId: String(l.league_id),
    leagueName: String(l.name || `League ${l.league_id}`),
    size: l.total_rosters != null ? Number(l.total_rosters) : null,
    myTeamId: null,       // would require a per-league roster lookup
    myTeamName: "",       // fill later if you query /rosters/me
    seasonId: Number(l.season || l.settings?.season),
    urls: {
      league: `https://sleeper.com/leagues/${l.league_id}`,
    },
  }));
}

export async function handleSleeper(request, url) {
  const season = Number(url.searchParams.get("season")) || THIS_YEAR;
  const user = (url.searchParams.get("user") || "").trim() ||
               (request.headers.get("x-sleeper-user") || "").trim();
  if (!user) return badRequest("Sleeper requires ?user=<usernameOrId> or X-SLEEPER-USER header.");

  try {
    const u = await sleeperResolveUser(user);
    const leagues = await sleeperGetLeagues(u.user_id, season);
    return json({ ok:true, platform: "sleeper", season, leagues: sleeperMapLeagues(leagues) });
  } catch (e) {
    return upstreamFail(String(e));
  }
}
