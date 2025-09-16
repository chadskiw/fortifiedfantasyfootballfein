const SEASON = 2025;
const BASE = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0`;

export function readCookies(cookieHeader = "") {
  const m = {};
  (cookieHeader || "").split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    m[k] = v;
  });
  return m;
}

export function creds(req) {
  const c = readCookies(req.headers.get("cookie"));
  const SWID = (req.headers.get("X-ESPN-SWID") || c.SWID || "").trim();
  const s2   = (req.headers.get("X-ESPN-S2")   || c.espn_s2 || "").trim();
  return { SWID, s2 };
}

export function week14Only(url) {
  const w = Number(url.searchParams.get("week"));
  if (!(w >= 1 && w <= 14)) return [null, new Response("Only weeks 1–14", { status: 400 })];
  return [w, null];
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function espnGet(path, { SWID, s2 }, params = {}) {
  const u = new URL(`${BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), {
    headers: { cookie: `SWID=${encodeURIComponent(SWID)}; espn_s2=${encodeURIComponent(s2)}` }
  });
  if (!r.ok) throw new Error(`ESPN ${r.status} ${path}`);
  return r.json();
}

export async function getLeagueRoster(leagueId) {
  // mRoster gives team roster slots + playerIds
  return espnGet(`leagues/${leagueId}`, { SWID: "", s2: "" }, { view: "mRoster" });
}
export async function getLeaguePlayers(leagueId, scoringPeriodId) {
  // kona_player_info gives player cards (names, pro team, projs, ownership)
  return espnGet(`leagues/${leagueId}`, { SWID: "", s2: "" }, {
    view: "kona_player_info",
    scoringPeriodId
  });
}

export async function fetchRoster({ leagueId, teamId, week, SWID, s2 }) {
  const [rosters, playersBlob] = await Promise.all([
    espnGet(`leagues/${leagueId}`, { SWID, s2 }, { view: "mRoster", scoringPeriodId: week }),
    espnGet(`leagues/${leagueId}`, { SWID, s2 }, { view: "kona_player_info", scoringPeriodId: week })
  ]);

  // index players by id from kona_player_info
  const pIndex = new Map();
  (playersBlob.players || []).forEach(p => pIndex.set(p.id, p));

  const team = (rosters.teams || []).find(t => String(t.id) === String(teamId));
  const entries = team?.roster?.entries || [];
  const mapped = entries.map(e => {
    const p = pIndex.get(e.playerId);
    const fullName = p?.player?.fullName || p?.fullName || "Unknown";
    const pos = (p?.player?.defaultPositionId ?? p?.defaultPositionId) ?? null;
    const proTeam = p?.player?.proTeamAbbreviation || p?.proTeamAbbreviation || "";
    // Pull a projection if available
    const proj =
      p?.player?.stats?.find(s => s.scoringPeriodId === week && s.statSourceId === 1)?.appliedTotal ??
      p?.player?.stats?.find(s => s.scoringPeriodId === week)?.appliedTotal ??
      null;

    return {
      slotId: e.lineupSlotId,
      playerId: e.playerId,
      name: fullName,
      positionId: pos,
      proTeam,
      proj
    };
  });

  return {
    teamId,
    week,
    players: mapped
  };
}

export async function fetchMatchup({ leagueId, teamId, week, SWID, s2 }) {
  const [matchups, rosters, playersBlob] = await Promise.all([
    espnGet(`leagues/${leagueId}`, { SWID, s2 }, { view: "mMatchupScore", scoringPeriodId: week }),
    espnGet(`leagues/${leagueId}`, { SWID, s2 }, { view: "mRoster", scoringPeriodId: week }),
    espnGet(`leagues/${leagueId}`, { SWID, s2 }, { view: "kona_player_info", scoringPeriodId: week })
  ]);

  const pIndex = new Map();
  (playersBlob.players || []).forEach(p => pIndex.set(p.id, p));

  const schedule = matchups.schedule || [];
  const myTeamId = Number(teamId);
  const thisMatch = schedule.find(m => m.home?.teamId === myTeamId || m.away?.teamId === myTeamId);
  if (!thisMatch) return { week, matchup: null };

  const teamMap = new Map((rosters.teams || []).map(t => [t.id, t]));
  function mapTeam(id) {
    const t = teamMap.get(id);
    const entries = t?.roster?.entries || [];
    const players = entries.map(e => {
      const p = pIndex.get(e.playerId);
      const fullName = p?.player?.fullName || p?.fullName || "Unknown";
      const pos = (p?.player?.defaultPositionId ?? p?.defaultPositionId) ?? null;
      const proTeam = p?.player?.proTeamAbbreviation || p?.proTeamAbbreviation || "";
      const proj =
        p?.player?.stats?.find(s => s.scoringPeriodId === week && s.statSourceId === 1)?.appliedTotal ??
        p?.player?.stats?.find(s => s.scoringPeriodId === week)?.appliedTotal ??
        null;
      return { slotId: e.lineupSlotId, playerId: e.playerId, name: fullName, positionId: pos, proTeam, proj };
    });
    const teamName = `${t?.location ?? ""} ${t?.nickname ?? ""}`.trim();
    const projTotal = players.reduce((a, b) => a + (Number(b.proj) || 0), 0);
    return { teamId: id, teamName, players, projTotal };
  }

  const home = mapTeam(thisMatch.home.teamId);
  const away = mapTeam(thisMatch.away.teamId);

  return {
    week,
    matchup: {
      home, away,
      isHome: myTeamId === home.teamId
    }
  };
}

export async function fetchFreeAgents({ leagueId, week, SWID, s2, limit = 50 }) {
  // Use kona_player_info listing and filter by FREEAGENT status if available.
  const blob = await espnGet(`leagues/${leagueId}`, { SWID, s2 }, {
    view: "kona_player_info",
    scoringPeriodId: week
  });

  const pool = (blob.players || []);
  // Heuristic: treat players with no team roster entry & onTeamId === 0 as FA
  const fas = pool.filter(p => {
    const teamId = p?.onTeamId ?? p?.ownership?.teamId ?? 0;
    const status = p?.status;
    return !teamId || teamId === 0 || status === "FREEAGENT";
  }).slice(0, limit).map(p => {
    const fullName = p?.player?.fullName || p?.fullName || "Unknown";
    const pos = (p?.player?.defaultPositionId ?? p?.defaultPositionId) ?? null;
    const proTeam = p?.player?.proTeamAbbreviation || p?.proTeamAbbreviation || "";
    const proj =
      p?.player?.stats?.find(s => s.scoringPeriodId === week && s.statSourceId === 1)?.appliedTotal ??
      p?.player?.stats?.find(s => s.scoringPeriodId === week)?.appliedTotal ??
      null;
    return { playerId: p.id, name: fullName, positionId: pos, proTeam, proj };
  });

  return { week, freeAgents: fas };
}
