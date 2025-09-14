// src/worker.ts
// Cloudflare Worker that proxies ESPN Fantasy Football (Weeks 1–14 only)
// Auth via ESPN cookies: SWID and espn_s2 (headers or query)
//   Headers:  X-ESPN-SWID: {SWID}   X-ESPN-S2: {espn_s2}
//   Query:    ?swid={SWID}&s2={espn_s2}

export interface Env {
  FP_API_KEY?: string;        // FantasyPros API key (optional; used for DST/ECR, etc.)
  TZ?: string;
  ECR_CACHE: KVNamespace;     // KV binding for caches (bye weeks, per-week player cache, etc.)
  ECR_REFRESH_TOKEN?: string; // example secret
}

const SEASON = 2025;
const REG_WEEKS = new Set(Array.from({ length: 14 }, (_, i) => i + 1));

/* ------------------------- Small response helpers ------------------------- */
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });

const badReq = (msg: string, status = 400) => json({ error: msg }, status);

/* ------------------------------ Team helpers ------------------------------ */
const PROTEAM_BY_ID: Record<number, string> = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',
  9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',
  17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',
  25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU',
};
const PRO_FIX: Record<string,string> = { JAC:'JAX', WAS:'WSH', SD:'LAC', OAK:'LV', LA:'LAR' };

function toAbbr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return PROTEAM_BY_ID[v] || '';
  const s = String(v).toUpperCase().replace(/[^A-Z]/g,'');
  return PRO_FIX[s] || s;
}

function proTeamAbbrOfPlayer(p: any): string {
  const cands = [
    p?.proTeamId, p?.proTeamAbbreviation, p?.proTeamAbbr, p?.proTeam,
    p?.player?.proTeamId, p?.player?.proTeamAbbreviation, p?.player?.proTeamAbbr,
  ];
  for (const c of cands) {
    const ab = toAbbr(c);
    if (ab) return ab;
  }
  return '';
}

/* ------------------------------ ESPN helpers ------------------------------ */
function getCreds(req: Request) {
  const url = new URL(req.url);
  const swid = req.headers.get("X-ESPN-SWID") || url.searchParams.get("swid") || "";
  const s2   = req.headers.get("X-ESPN-S2")   || url.searchParams.get("s2")   || "";
  if (!swid || !s2) return null;
  return { swid, s2 };
}

function requireWeek(req: Request) {
  const url = new URL(req.url);
  const wStr = url.searchParams.get("week");
  if (!wStr) throw new Error("Missing week");
  const w = Number(wStr);
  if (!Number.isInteger(w) || !REG_WEEKS.has(w)) throw new Error("Only weeks 1–14 are supported right now.");
  return w;
}

function requireParam(req: Request, name: string) {
  const url = new URL(req.url);
  const v = url.searchParams.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function espnGet(url: string, swid: string, s2: string) {
  const res = await fetch(url, {
    headers: {
      "Cookie": `SWID=${swid}; espn_s2=${s2}`,
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 FF-Cloudflare-Worker",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

/* ------------------------------- FP DST ECR ------------------------------- */
async function fetchDstEcrMap(env: Env, season: number, week: number) {
  if (!env?.FP_API_KEY) return null;
  const url = `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?position=DST&type=consensus&scoring=STD&week=${week}`;
  const res = await fetch(url, { headers: { 'x-api-key': env.FP_API_KEY } });
  if (!res.ok) return null;
  const data = await res.json<any>().catch(()=>null);
  if (!data?.players) return null;

  const map: Record<string, number> = {};
  for (const pl of data.players) {
    const ab = String(pl.player_team_id || '').toUpperCase();
    const rank = Number(pl.rank_ecr ?? pl.pos_rank);
    if (ab && Number.isFinite(rank)) map[ab] = rank;
  }
  return map;
}

/* ------------------------------ FMV utilities ----------------------------- */
// Placeholder FMV = projected total; swap in your real formula when ready
function fmvForPlayerWeek(p: any, week: number): number {
  const stats = p?.stats || [];
  const wk = stats.find((s: any) => s?.statSourceId === 1 && s?.scoringPeriodId === week); // 1=projected
  const proj = wk?.appliedTotal ?? wk?.appliedStatTotal ?? 0;
  return Number(proj) || 0;
}

function sumTeamFMV(entries: any[], week: number, onlyStarters = true): number {
  const STARTER_SLOTS = new Set([0,2,3,4,5,16,17,19]); // QB,RB,WR,TE,FLEX,DST,K,UTIL (adjust as needed)
  const roster = onlyStarters ? entries.filter((re: any) => STARTER_SLOTS.has(re?.lineupSlotId)) : entries;

  let total = 0;
  for (const re of roster) {
    const player = re?.playerPoolEntry?.player || re?.player;
    if (!player) continue;
    total += fmvForPlayerWeek(player, week);
  }
  return Number(total.toFixed(2));
}

/* ------------------------------ KV cache utils ---------------------------- */
async function cacheGet(env: Env, key: string) {
  try { return env?.ECR_CACHE ? await env.ECR_CACHE.get(key, "json") : null; }
  catch { return null; }
}
async function cachePut(env: Env, key: string, value: any, ttlSeconds = 60 * 60 * 6) {
  try { if (env?.ECR_CACHE) await env.ECR_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }); }
  catch {}
}

/* ---------------------------- Week/Bye calculators ------------------------ */
const NFL_TEAMS: readonly string[] = [
  "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB",
  "HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ",
  "PHI","PIT","SEA","SF","TB","TEN","WSH"
];

function toProAbbr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).toUpperCase().replace(/[^A-Z]/g, "");
  if (s === "JAC") return "JAX";
  if (s === "WAS") return "WSH";
  if (s === "SD")  return "LAC";
  if (s === "OAK") return "LV";
  if (s === "STL" || s === "LA") return "LAR";
  return s;
}

async function fetchWeekTeams(season: string | number, week: number): Promise<Set<string>> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${season}&week=${week}&seasontype=2`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`scoreboard ${res.status} (w${week})`);
  const j = await res.json();

  const present = new Set<string>();
  const events = Array.isArray(j?.events) ? j.events : [];
  for (const ev of events) {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    const teams = Array.isArray(comp?.competitors) ? comp.competitors : [];
    for (const t of teams) {
      const ab = toProAbbr(t?.team?.abbreviation ?? t?.team?.abbrev ?? t?.team?.id);
      if (ab) present.add(ab);
    }
  }
  return present;
}

// Compute { TEAM_ABBR: byeWeek } by scanning weeks 1..18
async function computeByeWeeksFromScoreboard(season: string | number): Promise<Record<string, number>> {
  const byeWeeks: Record<string, number> = {};
  const remaining = new Set(NFL_TEAMS);

  for (let wk = 1; wk <= 18; wk++) {
    if (remaining.size === 0) break;

    let present: Set<string> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        present = await fetchWeekTeams(season, wk);
        break;
      } catch {
        if (attempt === 1) throw;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    present = present ?? new Set<string>();

    for (const team of Array.from(remaining)) {
      if (!present.has(team)) byeWeeks[team] = wk;
    }
    for (const [team, w] of Object.entries(byeWeeks)) {
      if (w === wk) remaining.delete(team);
    }
  }

  for (const [abbr, w] of Object.entries(byeWeeks)) {
    if (!Number.isInteger(w) || w < 1 || w > 18) delete byeWeeks[abbr];
  }
  return byeWeeks;
}

/* ------------------------------- Handlers -------------------------------- */
function parseWeeksParam(req: Request): number[] {
  const url = new URL(req.url);
  const raw = url.searchParams.get("weeks");
  const defaultWeeks = Array.from(REG_WEEKS.values()); // 1..14
  if (!raw) return defaultWeeks;

  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let w = Math.min(a,b); w <= Math.max(a,b); w++) out.add(w);
      }
    } else {
      const n = Number(part.trim());
      if (Number.isInteger(n)) out.add(n);
    }
  }
  const arr = Array.from(out).filter(w => REG_WEEKS.has(w)).sort((a,b)=>a-b);
  return arr.length ? arr : defaultWeeks;
}

function extractWeeklyFromPlayer(player: any, week: number) {
  const stats = Array.isArray(player?.stats) ? player.stats : [];
  const projRow   = stats.find((s: any) => s?.statSourceId === 1 && s?.scoringPeriodId === week); // 1=projected
  const actualRow = stats.find((s: any) => s?.statSourceId === 0 && s?.scoringPeriodId === week); // 0=actual

  const proj   = Number(projRow?.appliedTotal ?? projRow?.appliedStatTotal ?? null);
  const actual = Number(actualRow?.appliedTotal ?? actualRow?.appliedStatTotal ?? null);
  const fmv    = Number.isFinite(proj) ? proj : (Number.isFinite(actual) ? actual : null);

  return {
    proj:   Number.isFinite(proj)   ? Number(proj.toFixed(2))   : null,
    fmv:    Number.isFinite(fmv)    ? Number(fmv.toFixed(2))    : null,
    actual: Number.isFinite(actual) ? Number(actual.toFixed(2)) : null
  };
}

async function handlePlayer(request: Request, env: Env) {
  const creds = getCreds(request);
  if (!creds) return badReq("Provide SWID + espn_s2 via headers or query.");

  const url = new URL(request.url);
  const leagueId = url.searchParams.get("leagueId");
  const playerId = url.searchParams.get("playerId");
  const season   = Number(url.searchParams.get("season") || SEASON);
  if (!leagueId) return badReq("Missing leagueId");
  if (!playerId) return badReq("Missing playerId");

  const weeks = parseWeeksParam(request);
  const results: Array<{ week: number; proj: number|null; fmv: number|null; actual: number|null; }> = [];
  let meta: any = null;

  for (const week of weeks) {
    const kvKey = `plwk:${season}:${leagueId}:${week}:${playerId}`;
    const cached = await cacheGet(env, kvKey);
    if (cached && typeof cached === "object") {
      if (!meta && (cached as any).meta) meta = (cached as any).meta;
      results.push({ week, proj: (cached as any).proj, fmv: (cached as any).fmv, actual: (cached as any).actual });
      continue;
    }

    const endpoint = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=kona_player_info`;
    const data = await espnGet(endpoint, creds.swid, creds.s2);

    const hit = (Array.isArray(data?.players) ? data.players : []).find((pp: any) =>
      String(pp?.player?.id) === String(playerId)
    );

    const p = hit?.player;
    const wk = extractWeeklyFromPlayer(p || {}, week);

    if (!meta && p) {
      meta = {
        id: p.id,
        firstName: p.firstName,
        lastName:  p.lastName,
        name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
        pos: p?.defaultPositionId ?? p?.position ?? null,
        proTeamId: p?.proTeamId ?? null,
        proTeamAbbrev: p?.proTeamAbbrev ?? p?.proTeam ?? null
      };
    }

    results.push({ week, proj: wk.proj, fmv: wk.fmv, actual: wk.actual });
    await cachePut(env, kvKey, { proj: wk.proj, fmv: wk.fmv, actual: wk.actual, meta }, 60 * 60 * 6);
  }

  results.sort((a,b)=>a.week-b.week);
  return json({ leagueId, playerId, season, player: meta || { id: Number(playerId) }, weeks: results });
}

async function handleRoster(request: Request) {
  const creds = getCreds(request);
  if (!creds) return badReq("Provide SWID + espn_s2 via headers or query.");
  let week: number, leagueId: string, teamId: string;
  try {
    week = requireWeek(request);
    leagueId = requireParam(request, "leagueId");
    teamId = requireParam(request, "teamId");
  } catch (e: any) {
    return badReq(e.message);
  }

  const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mRoster`;
  const data = await espnGet(url, creds.swid, creds.s2);

  const tm = (data?.teams || []).find((t: any) => String(t?.id) === String(teamId));
  if (!tm) return badReq("Team not found in league.");

  const entries = tm?.roster?.entries || [];
  const enriched = entries.map((re: any) => {
    const player = re?.playerPoolEntry?.player || re?.player;
    const fmv = player ? fmvForPlayerWeek(player, week) : 0;
    return { ...re, fmv };
  });

  const teamFMV = sumTeamFMV(enriched, week, true);
  return json({ leagueId, teamId, week, teamFMV, roster: enriched });
}

async function handleFreeAgents(request: Request) {
  const creds = getCreds(request);
  if (!creds) return badReq("Provide SWID + espn_s2 via headers or query.");
  let week: number, leagueId: string;
  try {
    week = requireWeek(request);
    leagueId = requireParam(request, "leagueId");
  } catch (e: any) {
    return badReq(e.message);
  }

  const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=kona_player_info`;
  const data = await espnGet(url, creds.swid, creds.s2);

  const players = data?.players || [];
  const freeAgents = players.filter((pp: any) => pp?.onTeamId == null);

  const enriched = freeAgents.map((pp: any) => {
    const player = pp?.player;
    return {
      id: player?.id,
      fullName: `${player?.firstName ?? ""} ${player?.lastName ?? ""}`.trim(),
      defaultPositionId: player?.defaultPositionId,
      proTeamId: player?.proTeamId,
      fmv: fmvForPlayerWeek(player, week),
    };
  });

  enriched.sort((a: any, b: any) => b.fmv - a.fmv);
  return json({ leagueId, week, count: Math.min(enriched.length, 30), freeAgents: enriched.slice(0, 30) });
}

async function handleMatchup(request: Request) {
  const creds = getCreds(request);
  if (!creds) return badReq("Provide SWID + espn_s2 via headers or query.");
  let week: number, leagueId: string, teamId: string;
  try {
    week = requireWeek(request);
    leagueId = requireParam(request, "leagueId");
    teamId = requireParam(request, "teamId");
  } catch (e: any) {
    return badReq(e.message);
  }

  const [matchups, leagueRoster] = await Promise.all([
    espnGet(`https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mMatchupScore`, creds.swid, creds.s2),
    espnGet(`https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mRoster`, creds.swid, creds.s2),
  ]);

  const schedule = matchups?.schedule || [];
  const game = schedule.find((s: any) =>
    String(s?.home?.teamId) === String(teamId) || String(s?.away?.teamId) === String(teamId)
  );
  if (!game) return badReq("No matchup found for that team/week.");

  const teams = leagueRoster?.teams || [];
  const homeTeam = teams.find((t: any) => String(t?.id) === String(game.home.teamId));
  const awayTeam = teams.find((t: any) => String(t?.id) === String(game.away.teamId));

  const homeEntries = homeTeam?.roster?.entries ?? [];
  const awayEntries = awayTeam?.roster?.entries ?? [];

  const homeFMV = sumTeamFMV(homeEntries, week, true);
  const awayFMV = sumTeamFMV(awayEntries, week, true);

  return json({
    leagueId, week,
    home: {
      teamId: game.home.teamId,
      score: game.home.totalPoints ?? 0,
      proj:  game.home.additionalStats?.find((x: any) => x?.statId === "102")?.value ?? undefined,
      teamFMV: homeFMV,
    },
    away: {
      teamId: game.away.teamId,
      score: game.away.totalPoints ?? 0,
      proj:  game.away.additionalStats?.find((x: any) => x?.statId === "102")?.value ?? undefined,
      teamFMV: awayFMV,
    },
  });
}

async function handleByeWeeks(request: Request, env: Env) {
  const url = new URL(request.url);
  const season   = url.searchParams.get("season") || String(new Date().getFullYear());
  const leagueId = url.searchParams.get("leagueId") || null; // optional, echo
  const teamId   = url.searchParams.get("teamId")   || null; // optional, echo

  let byeWeeks = (await env.ECR_CACHE.get(`bye:${season}`, "json")) as Record<string, number> | null;

  if (!byeWeeks) {
    byeWeeks = await computeByeWeeksFromScoreboard(season);
    await env.ECR_CACHE.put(`bye:${season}`, JSON.stringify(byeWeeks), { expirationTtl: 60 * 60 * 6 });
  }

  // guard (ints 1..18)
  for (const [abbr, w] of Object.entries(byeWeeks)) {
    if (!Number.isInteger(w) || w < 1 || w > 18) delete (byeWeeks as any)[abbr];
  }

  return json({ ok: true, season, leagueId, teamId, byeWeeks });
}

/* --------------------------------- Router -------------------------------- */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const method = request.method.toUpperCase();

      // Debug env (safe: only presence/type)
      if (pathname === "/api/debug-env") {
        const report: Record<string, string> = {};
        report.FP_API_KEY        = env.FP_API_KEY ? "set" : "missing";
        report.TZ                = env.TZ ? "set" : "missing";
        report.ECR_REFRESH_TOKEN = env.ECR_REFRESH_TOKEN ? "set" : "missing (should be a secret)";
        report.ECR_CACHE         = env.ECR_CACHE ? "KVNamespace bound" : "missing";
        return json({ ok: true, report });
      }

      if (pathname === "/" || pathname === "/api/health") {
        return json({ ok: true, season: SEASON, weeks: "1-14" });
      }

      if (method !== "GET") return badReq("Only GET supported here.", 405);

      if (pathname === "/api/roster")       return handleRoster(request);
      if (pathname === "/api/free-agents")  return handleFreeAgents(request);
      if (pathname === "/api/matchup")      return handleMatchup(request);
      if (pathname === "/api/player")       return handlePlayer(request, env);
      if (pathname === "/api/bye-weeks")    return handleByeWeeks(request, env);

      return new Response("Not found", { status: 404 });
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
