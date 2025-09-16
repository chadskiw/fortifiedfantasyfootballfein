// /api/platforms/sleeper/league/[leagueId]/teams.js
// -----------------------------------------------------------------------------
// Returns teams for a specific Sleeper league.
// Shape:
// { ok, platform:"sleeper", season, leagueId, teams:[
//    { teamId, teamName, abbrev, owner, owners:[], logo, teamAbbrev:null, teamLogo:null, urls:{} }
// ] }
//
// Notes:
// - `season` is accepted for parity but not required by Sleeper (leagueId is unique).
// - No auth/cookies are required for Sleeper public endpoints.
// - Owner & team display prefer user.metadata.team_name -> display_name -> username.
// - Logo uses Sleeper CDN if user.avatar is an ID.
//
// Example:
// GET /api/platforms/sleeper/league/1181825673767903232/teams?season=2025
// -----------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
function badRequest(msg){ return json({ ok:false, error:msg }, 400); }
function upstreamFail(msg){ return json({ ok:false, error:msg }, 502); }

function sleeperAvatarUrl(avatar) {
  if (!avatar) return null;
  // If they already provided a full URL, use it.
  if (/^https?:\/\//i.test(avatar)) return avatar;
  // Otherwise construct from Sleeper CDN:
  // thumbs => smaller; originals => full size. Use thumbs for table rows.
  return `https://sleepercdn.com/avatars/thumbs/${encodeURIComponent(avatar)}`;
}

export const onRequestGet = async ({ request, params }) => {
  const leagueId = String(params?.leagueId || "").trim();
  const url = new URL(request.url);
  const season = Number(url.searchParams.get("season")) || new Date().getUTCFullYear();

  if (!leagueId) return badRequest("leagueId required");

  try {
    // Fetch league, users, rosters in parallel (league optional, but cheap).
    const [leagueRes, usersRes, rostersRes] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueId}`),
      fetch(`https://api.sleeper.app/v1/league/${leagueId}/users`),
      fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`),
    ]);

    if (!usersRes.ok) throw new Error(`Sleeper users ${usersRes.status}`);
    if (!rostersRes.ok) throw new Error(`Sleeper rosters ${rostersRes.status}`);

    // leagueRes can 404 for old/archived; don’t fail the whole call.
    const leagueJson = leagueRes.ok ? await leagueRes.json().catch(()=>null) : null;
    const users = await usersRes.json();
    const rosters = await rostersRes.json();

    const userMap = new Map(
      (Array.isArray(users) ? users : []).map(u => [String(u.user_id), u])
    );

    const teams = (Array.isArray(rosters) ? rosters : []).map(r => {
      const u = userMap.get(String(r.owner_id));
      const displayTeam =
        (u?.metadata?.team_name && String(u.metadata.team_name).trim()) ||
        (u?.display_name && String(u.display_name).trim()) ||
        (u?.username && String(u.username).trim()) ||
        `Roster ${r.roster_id}`;

      const ownerDisplay =
        (u?.display_name && String(u.display_name).trim()) ||
        (u?.username && String(u.username).trim()) ||
        "";

      const logo = sleeperAvatarUrl(u?.avatar || u?.metadata?.avatar);

      // Fantasy "teamAbbrev"/"teamLogo" don't exist on Sleeper; keep null for parity.
      return {
        teamId: Number(r.roster_id),
        teamName: displayTeam,
        abbrev: null,
        owner: ownerDisplay,
        owners: ownerDisplay ? [ownerDisplay] : [],
        logo,
        teamAbbrev: null,
        teamLogo: null,
        urls: { league: `https://sleeper.com/leagues/${leagueId}` }
      };
    });

    return json({
      ok: true,
      platform: "sleeper",
      season,
      leagueId,
      leagueName: leagueJson?.name || null,
      teams
    });
  } catch (e) {
    return upstreamFail(String(e?.message || e));
  }
};
