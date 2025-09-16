// functions/api/matchup.js
// GET /api/matchup?leagueId=123&teamId=4&week=2&season=2025
// -> { ok, season, week, home:{teamId, teamName, owner, logo}, away:{...}, opponentTeamId, opponentName }

function j(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function normalizeSwid(s){ return s ? `{${String(s).replace(/[{}]/g,"").trim()}}` : s; }

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId");
    const teamId   = u.searchParams.get("teamId");
    const season   = Number(u.searchParams.get("season") || new Date().getUTCFullYear());
    const week     = Number(u.searchParams.get("week") || 1);

    if (!leagueId || !teamId) return j({ ok:false, error:"leagueId and teamId required" }, 400);

    // cookies from caller (set by /api/espn/link)
    const cookieHdr = request.headers.get("cookie") || "";
    const SWIDraw = /(?:^|;\s*)SWID=([^;]+)/.exec(cookieHdr)?.[1];
    const S2raw   = /(?:^|;\s*)(?:espn_s2|ESPN_S2|s2)=([^;]+)/.exec(cookieHdr)?.[1];
    if (!SWIDraw || !S2raw) return j({ ok:false, error:"Not linked (SWID/espn_s2 missing)" }, 401);
    const swid = normalizeSwid(decodeURIComponent(SWIDraw));
    const s2   = decodeURIComponent(S2raw);

    // Pull schedule + teams once; filter for week locally
    const url =
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
      `/segments/0/leagues/${leagueId}` +
      `?view=mMatchupScore&view=mTeam&view=mSettings`;

    const r = await fetch(url, {
      headers: {
        cookie: `SWID=${swid}; espn_s2=${s2}`,
        accept: "application/json",
        origin: "https://fantasy.espn.com",
        referer: `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
        "x-fantasy-platform": "kona-PROD",
        "x-fantasy-source": "kona",
        "user-agent": "Mozilla/5.0 FortifiedFantasy"
      },
      redirect: "manual"
    });

    const txt = await r.text();
    if (!r.ok) return j({ ok:false, error:`ESPN ${r.status}`, snippet:txt.slice(0,200) }, 502);
    const league = JSON.parse(txt);

    const teams = league.teams || [];
    const members = league.members || [];
    const byId = id => teams.find(t => String(t.id) === String(id));

    const teamName = t =>
      t ? (`${t.location ?? ""} ${t.nickname ?? ""}`).trim() || t.name || `Team ${t.id}` : `Team ${t}`;

    const teamLogo = t =>
      (t && t.logo) ? t.logo : ""; // add your own fallback if desired

    const ownerName = t => {
      if (!t) return "—";
      const ownerId = t.primaryOwner || (Array.isArray(t.owners) ? t.owners[0] : null);
      if (!ownerId) return "—";
      const m = members.find(mm => String(mm.id) === String(ownerId));
      if (!m) return "—";
      const full = [m.firstName, m.lastName].filter(Boolean).join(" ").trim();
      return full || m.displayName || "—";
    };

    const myId = String(teamId);
    const schedule = league.schedule || [];

    // Prefer exact fantasy week via matchupPeriodId (the league's scoring week)
    let game = schedule.find(s =>
      (String(s.home?.teamId ?? s.homeId ?? "") === myId ||
       String(s.away?.teamId ?? s.awayId ?? "") === myId) &&
      Number(s.matchupPeriodId) === week
    );

    // Fallback: look for pointsByScoringPeriod having this scoring period
    if (!game) {
      game = schedule.find(s => {
        const h = String(s.home?.teamId ?? s.homeId ?? "");
        const a = String(s.away?.teamId ?? s.awayId ?? "");
        if (h !== myId && a !== myId) return false;
        const keysH = Object.keys(s.home?.pointsByScoringPeriod || {});
        const keysA = Object.keys(s.away?.pointsByScoringPeriod || {});
        return keysH.includes(String(week)) || keysA.includes(String(week));
      });
    }

    if (!game) return j({ ok:false, error:`No matchup found for team ${teamId} in week ${week}` }, 404);

    const homeId = String(game.home?.teamId ?? game.homeId ?? "");
    const awayId = String(game.away?.teamId ?? game.awayId ?? "");
    const opponentTeamId = (homeId === myId) ? awayId : homeId;

    const homeTeam = byId(homeId);
    const awayTeam = byId(awayId);
    const oppTeam  = byId(opponentTeamId);

    return j({
      ok: true,
      season, week,
      home: {
        teamId: Number(homeId),
        teamName: teamName(homeTeam),
        owner: ownerName(homeTeam),
        logo: teamLogo(homeTeam)
      },
      away: {
        teamId: Number(awayId),
        teamName: teamName(awayTeam),
        owner: ownerName(awayTeam),
        logo: teamLogo(awayTeam)
      },
      opponentTeamId: Number(opponentTeamId),
      opponentName: teamName(oppTeam)
    });

  } catch (e) {
    return j({ ok:false, error:String(e) }, 502);
  }
};
