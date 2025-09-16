// functions/api/[[all]].ts
// Handle a few ESPN proxy endpoints; FORWARD everything else under /api/*.
// This lets file-based routes like /api/fein/upsert-meta run.

export const onRequest: PagesFunction = async (context) => {
  const { request } = context;
  const url = new URL(request.url);

  // We live under /api/*
  const path = url.pathname.replace(/^\/api/, ""); // e.g. "/roster", "/fein/upsert-meta"
  const method = request.method;
  const DEFAULT_SEASON = 2025;

  // If this file doesn't handle the path, let the next route handle it.
  if (!["/roster", "/free-agents", "/matchup"].includes(path)) {
    return context.next(); // <-- critical: forward to /api/fein/upsert-meta, /api/ecr/dst, etc.
  }

  // ---------- helpers (scoped to this file) ----------
  const REG_WEEKS = new Set(Array.from({ length: 14 }, (_, i) => i + 1));

  function json(body: any, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", "vary": "cookie" },
    });
  }
  function bad(msg: string, status = 400) { return json({ error: msg }, status); }

  function getCreds(req: Request) {
    const u = new URL(req.url);
    const swid = req.headers.get("X-ESPN-SWID") || u.searchParams.get("swid") || "";
    const s2   = req.headers.get("X-ESPN-S2")   || u.searchParams.get("s2")   || "";
    if (!swid || !s2) return null;
    return { swid, s2 };
  }
  function requireParam(u: URL, name: string) {
    const v = u.searchParams.get(name);
    if (!v) throw new Error(`Missing ${name}`);
    return v;
  }
  function requireWeek(u: URL) {
    const w = Number(requireParam(u, "week"));
    if (!Number.isInteger(w) || !REG_WEEKS.has(w)) throw new Error("Only weeks 1–14 are supported right now.");
    return w;
  }
  async function espnGet(url: string, swid: string, s2: string) {
    const r = await fetch(url, {
      headers: {
        "Cookie": `SWID=${swid}; espn_s2=${s2}`,
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "FF4-Pages-Function",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!r.ok) throw new Error(`ESPN ${r.status}: ${await r.text()}`);
    return r.json();
  }
  function fmvForPlayerWeek(p: any, week: number): number {
    const wk = (p?.stats || []).find((s: any) => s?.statSourceId === 1 && s?.scoringPeriodId === week);
    const proj = wk?.appliedTotal ?? wk?.appliedStatTotal ?? 0;
    return Number(proj) || 0;
  }
  function sumTeamFMV(entries: any[], week: number, startersOnly = true) {
    const STARTER_SLOTS = new Set([0,2,3,4,5,16,17,19]);
    const roster = startersOnly ? entries.filter((re: any) => STARTER_SLOTS.has(re?.lineupSlotId)) : entries;
    let total = 0;
    for (const re of roster) {
      const player = re?.playerPoolEntry?.player || re?.player;
      if (player) total += fmvForPlayerWeek(player, week);
    }
    return Number(total.toFixed(2));
  }

  // ---------- actual handlers ----------
  const season = Number(url.searchParams.get("season")) || DEFAULT_SEASON;

  if (path === "/roster") {
    if (method !== "GET") return bad("Method not allowed", 405);
    const creds = getCreds(request);
    if (!creds) return bad("Provide SWID + espn_s2 via headers or query.");
    try {
      const week = requireWeek(url);
      const leagueId = requireParam(url, "leagueId");
      const teamId = requireParam(url, "teamId");
      const data = await espnGet(
        `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mRoster`,
        creds.swid, creds.s2
      );
      const tm = (data?.teams || []).find((t: any) => String(t?.id) === String(teamId));
      if (!tm) return bad("Team not found in league.");
      const entries = tm?.roster?.entries || [];
      const enriched = entries.map((re: any) => {
        const player = re?.playerPoolEntry?.player || re?.player;
        return { ...re, fmv: player ? fmvForPlayerWeek(player, week) : 0 };
      });
      return json({
        ok: true,
        leagueId, teamId, week,
        team_name: tm?.location && tm?.nickname ? `${tm.location} ${tm.nickname}` : undefined,
        teamIdNum: tm?.id,
        players: enriched.map((re:any) => {
          const p = re?.playerPoolEntry?.player || re?.player || {};
          return {
            id: p?.id,
            name: `${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim(),
            positionId: p?.defaultPositionId,
            position: p?.position ?? p?.defaultPositionId,
            proTeamId: p?.proTeamId,
            proTeamAbbr: p?.proTeamAbbreviation,
            opponent: p?.opponent,
            defensiveRank: p?.defensiveRank,
            proj: fmvForPlayerWeek(p, week),
            fmv: re?.fmv,
            slotId: re?.lineupSlotId
          };
        })
      });
    } catch (e:any) {
      return bad(String(e?.message || e), 500);
    }
  }

  if (path === "/free-agents") {
    if (method !== "GET") return bad("Method not allowed", 405);
    const creds = getCreds(request);
    if (!creds) return bad("Provide SWID + espn_s2 via headers or query.");
    try {
      const week = requireWeek(url);
      const leagueId = requireParam(url, "leagueId");
      const data = await espnGet(
        `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=kona_player_info`,
        creds.swid, creds.s2
      );
      const freeAgents = (data?.players || [])
        .filter((pp: any) => pp?.onTeamId == null)
        .map((pp: any) => {
          const player = pp?.player;
          const proj = fmvForPlayerWeek(player, week);
          return {
            id: player?.id,
            name: `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim(),
            positionId: player?.defaultPositionId,
            proTeamId: player?.proTeamId,
            proTeam: player?.proTeamAbbreviation,
            proj,
            fmv: proj,
            opponent: player?.opponent,
            defensiveRank: player?.defensiveRank,
            ecrRank: player?.ecrRank
          };
        })
        .sort((a:any,b:any)=> b.proj - a.proj)
        .slice(0, 30);

      return json({ ok: true, leagueId, week, freeAgents });
    } catch (e:any) {
      return bad(String(e?.message || e), 500);
    }
  }

  if (path === "/matchup") {
    if (method !== "GET") return bad("Method not allowed", 405);
    const creds = getCreds(request);
    if (!creds) return bad("Provide SWID + espn_s2 via headers or query.");
    try {
      const week = requireWeek(url);
      const leagueId = requireParam(url, "leagueId");
      const teamId = requireParam(url, "teamId");
      const [matchups, leagueRoster] = await Promise.all([
        espnGet(`https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mMatchupScore`, creds.swid, creds.s2),
        espnGet(`https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mRoster`, creds.swid, creds.s2),
      ]);
      const game = (matchups?.schedule || []).find((s: any) =>
        String(s?.home?.teamId) === String(teamId) || String(s?.away?.teamId) === String(teamId)
      );
      if (!game) return bad("No matchup found for that team/week.");
      const teams = leagueRoster?.teams || [];
      const homeTeam = teams.find((t: any) => String(t?.id) === String(game.home.teamId));
      const awayTeam = teams.find((t: any) => String(t?.id) === String(game.away.teamId));
      const homeFMV = sumTeamFMV(homeTeam?.roster?.entries ?? [], week, true);
      const awayFMV = sumTeamFMV(awayTeam?.roster?.entries ?? [], week, true);

      return json({
        ok: true, leagueId, week,
        home: { teamId: game.home.teamId, teamName: homeTeam?.location && homeTeam?.nickname ? `${homeTeam.location} ${homeTeam.nickname}` : undefined,
          score: game.home.totalPoints ?? 0, teamFMV: homeFMV },
        away: { teamId: game.away.teamId, teamName: awayTeam?.location && awayTeam?.nickname ? `${awayTeam.location} ${awayTeam.nickname}` : undefined,
          score: game.away.totalPoints ?? 0, teamFMV: awayFMV }
      });
    } catch (e:any) {
      return bad(String(e?.message || e), 500);
    }
  }

  // Should never get here due to early return, but just in case:
  return context.next();
};
