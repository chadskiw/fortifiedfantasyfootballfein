/* ============================================================================
   Path: functions/api/platforms/sleeper/leagues.js
   File: leagues.js
   Project: FEIN · Fortified Fantasy
   Description:
     GET /api/platforms/sleeper/leagues?user=<userIdOrName>&season=2025
     - Lists Sleeper NFL leagues for a user in a given season.
   ============================================================================ */

const THIS_YEAR = new Date().getUTCFullYear();

/* utils */
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
const badRequest   = (m) => json({ ok:false, error:m }, 400);
const notFound     = (m) => json({ ok:false, error:m }, 404);
const upstreamFail = (m) => json({ ok:false, error:m }, 502);

/* resolve username -> user_id with clearer errors */
async function resolveUserId(user) {
  const s = String(user || "").trim();
  if (!s) throw new Error("user (user_id or username) required");
  if (/^\d{6,}$/.test(s)) return s;

  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(s)}`, {
    headers: { accept: "application/json", "user-agent": "FortifiedFantasy/1.0 (+pages)" }
  });
  const body = await r.text(); // capture for messaging
  if (!r.ok) {
    // Map upstream 404 -> our 404 so you don't see a 502 anymore
    if (r.status === 404) throw Object.assign(new Error(`Sleeper user not found: ${s}`), { code: 404, body });
    throw Object.assign(new Error(`Sleeper user lookup ${r.status}`), { code: r.status, body });
  }
  const j = JSON.parse(body || "{}");
  if (!j?.user_id) throw Object.assign(new Error(`User not found: ${s}`), { code: 404, body });
  return String(j.user_id);
}

/* entry */
export const onRequestGet = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season")) || THIS_YEAR;
    const user = String(url.searchParams.get("user") || "").trim();
    if (!user) return badRequest("user (user_id or username) required");

    const userId = await resolveUserId(user);

    const leaguesRes = await fetch(`https://api.sleeper.app/v1/user/${userId}/leagues/nfl/${season}`, {
      headers: { accept: "application/json", "user-agent": "FortifiedFantasy/1.0 (+pages)" }
    });
    const leaguesBody = await leaguesRes.text();
    if (!leaguesRes.ok) {
      // Bubble clearer status instead of a generic 502
      const msg = `Sleeper leagues ${leaguesRes.status}`;
      const err = Object.assign(new Error(msg), { code: leaguesRes.status, body: leaguesBody });
      throw err;
    }
    const leagues = JSON.parse(leaguesBody || "[]");

    const out = leagues.map(l => ({
      leagueId: String(l.league_id),
      leagueName: String(l.name || ""),
      season: Number(l.season || season),
      size: Number(l.total_rosters || 0),
      scoringSettings: l.scoring_settings || null,
      urls: { league: `https://sleeper.com/leagues/${l.league_id}` }
    }));

    return json({ ok:true, platform:"sleeper", season, userId, leagues: out });
  } catch (e) {
    // Map common upstream codes to clearer responses
    if (e?.code === 404) return notFound(e.message || "Not found");
    if (e?.code >= 400 && e?.code < 500) return json({ ok:false, error:String(e.message || e) }, e.code);
    return upstreamFail(String(e?.message || e));
  }
};
