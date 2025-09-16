// functions/api/all-players.js
// Fortified Fantasy — ALL Players API (rostered + waivers + free agents)
// -------------------------------------------------------------------
// Goals (parity with free-agents.js)
//  - Reliable JSON from ESPN even when one host fails
//  - Consistent opponent resolution ('NYJ' | 'BYE' | null), no mixed types
//  - Avoid leaking future BYE into earlier weeks
//  - CSV ranks auto-backfill to the newest existing week <= W
//  - DvP lookup tolerant of missing keys
//  - Filters: ?minProj= (default 1), ?pos=QB|RB|WR|TE|K|DST|FLEX|ALL
//  - Debug: ?creds=1 (cookie echo), ?diag=1 (content-type/snippet), ?host=reads|main
//
// Differences vs free-agents.js
//  - Status filter includes ONTEAM + WAIVERS + FREEAGENT
//  - Return payload shape matches free-agents.js for easy client reuse

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

/* ------------------------------ constants/maps ------------------------------ */

const PROTEAM_BY_ID = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',
  9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',
  17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',
  25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};
const toAbbr = (id) => PROTEAM_BY_ID[Number(id)] || null;

const TEAM_NORM = { JAC: "JAX", WAS: "WSH", OAK: "LV", SD: "LAC", STL: "LAR", LA: "LAR" };
const normTeam = (abbr) => (TEAM_NORM[String(abbr || "").toUpperCase()] || String(abbr || "").toUpperCase());

const TEAM_FULL_BY_ABBR = {
  ATL:'Atlanta Falcons', BUF:'Buffalo Bills', CAR:'Carolina Panthers', CHI:'Chicago Bears',
  CIN:'Cincinnati Bengals', CLE:'Cleveland Browns', DAL:'Dallas Cowboys', DEN:'Denver Broncos',
  DET:'Detroit Lions', GB:'Green Bay Packers', HOU:'Houston Texans', IND:'Indianapolis Colts',
  JAX:'Jacksonville Jaguars', KC:'Kansas City Chiefs', LAC:'Los Angeles Chargers',
  LAR:'Los Angeles Rams', LV:'Las Vegas Raiders', MIA:'Miami Dolphins', MIN:'Minnesota Vikings',
  NE:'New England Patriots', NO:'New Orleans Saints', NYG:'New York Giants', NYJ:'New York Jets',
  PHI:'Philadelphia Eagles', PIT:'Pittsburgh Steelers', SEA:'Seattle Seahawks',
  SF:'San Francisco 49ers', TB:'Tampa Bay Buccaneers', TEN:'Tennessee Titans',
  WSH:'Washington Commanders', ARI:'Arizona Cardinals', BAL:'Baltimore Ravens'
};

// 🔧 Fixed: add 23 -> "DST"
const POS_BY_ID = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST", 23: "DST" };
const SLOT_IDS  = [0, 2, 4, 6, 17, 16]; // ESPN slot ids for QB,RB,WR,TE,K,DST

const clampWeek = (w) => { const n = Number(w); return Number.isInteger(n) && n >= 1 && n <= 18 ? n : 1; };
const toNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* --------------------------------- cookies ---------------------------------- */

function parseCookieHeader(cookieHeader) {
  const out = Object.create(null);
  if (!cookieHeader) return out;
  for (const p of cookieHeader.split(/; */)) {
    const idx = p.indexOf("="); if (idx < 0) continue;
    const k = decodeURIComponent(p.slice(0, idx).trim());
    const v = decodeURIComponent(p.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}
function normalizeSwid(s) {
  if (!s) return "";
  let sw = s.trim(); try { sw = decodeURIComponent(sw); } catch {}
  sw = sw.replace(/^"+|"+$/g, ""); // drop quotes
  if (!(sw.startsWith("{") && sw.endsWith("}"))) sw = `{${sw.replace(/^\{|\}$/g, "")}}`;
  return sw;
}

// 🔧 Enhanced: allow headers & env fallbacks
function resolveCreds(req, url, env) {
  const headers = req.headers;
  // 0) explicit headers
  let swid = headers.get("x-espn-swid") || "";
  let s2   = headers.get("x-espn-s2")   || "";

  // 1) cookies
  const cookies = parseCookieHeader(headers.get("cookie") || "");
  if (!swid) swid = cookies.SWID || "";
  if (!s2)   s2   = cookies.espn_s2 || cookies.ESPN_S2 || "";

  // 2) query
  const u = url instanceof URL ? url : new URL(String(url));
  if (!swid) swid = u.searchParams.get("swid") || "";
  if (!s2)   s2   = u.searchParams.get("s2") || u.searchParams.get("espn_s2") || "";

  // 3) env fallbacks (Cloudflare Pages → Environment variables)
  if (!swid && env && env.ESPN_SWID) swid = env.ESPN_SWID;
  if (!s2   && env && env.ESPN_S2)   s2   = env.ESPN_S2;

  swid = normalizeSwid(swid);
  return { swid, s2 };
}

function mask(t, left = 4, right = 4) {
  if (!t) return "";
  const s = String(t);
  if (s.length <= left + right) return s[0] + "***" + s.slice(-1);
  return s.slice(0, left) + "..." + s.slice(-right);
}

/* --------------------------- projections / rankings -------------------------- */

function rankPos(pos='') {
  const p = String(pos).toUpperCase();
  if (p === 'D/ST' || p === 'DEF' || p === 'DST/DEF' || p === 'D') return 'DST';
  return p;
}

function stripDstSuffix(name='') {
  return String(name)
    .replace(/\bD\/ST\b|\bDST\b|\bDefense\b|\bSpecial\s*Teams\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function getProjectedPoints(pl, week) {
  const W = Number(week);
  const stats =
    (pl && pl.player && Array.isArray(pl.player.stats) && pl.player.stats) ||
    (pl && Array.isArray(pl.stats) && pl.stats) ||
    [];
  if (!stats.length) return 0;

  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const firstFinite = (...vals) => { for (const v of vals) { if (v !== null) return v; } return null; };
  const valFrom = (r) => firstFinite(
    n(r?.appliedTotal),
    n(r?.appliedProjectedTotal),
    n(r?.totalProjectedPoints),
    n(r?.appliedAverage),
    n(r?.points)
  );

  // Prefer projections for W (statSourceId=1), then any row for W, else latest projection row
  let row =
    stats.find(s => Number(s.scoringPeriodId) === W && Number(s.statSourceId) === 1 && Number(s.statSplitTypeId) === 1) ||
    stats.find(s => Number(s.scoringPeriodId) === W && Number(s.statSourceId) === 1) ||
    stats.find(s => Number(s.scoringPeriodId) === W);
  let v = row ? valFrom(row) : null;
  if (v !== null) return v;

  const recentProj = stats.filter(s => Number(s.statSourceId) === 1)
    .sort((a,b) => Number(b.scoringPeriodId||0) - Number(a.scoringPeriodId||0))[0];
  v = recentProj ? valFrom(recentProj) : null;
  if (v !== null) return v;

  for (const s of stats) { const t = valFrom(s); if (t !== null) return t; }
  return 0;
}

// FMV (original): requires positional rank + DvP
function computeFMV_og(posRank, dvp, position) {
  const P = rankPos(position);
  if (P === 'QB' || P === 'K' || P === 'DST') return posRank + dvp;
  if (P === 'TE') return (posRank / 1.4) + dvp;
  return (posRank / 2) + dvp; // RB/WR (and anything else)
}

/* ----------------------------- opponent + DvP -------------------------------- */
// Returns 'BYE', 'NYJ', etc., or null if unknown
function opponentFromSchedule(teamAbbr, week, byTeamWeekOpp) {
  const ab = normTeam(teamAbbr);
  const W  = Number(week);
  return byTeamWeekOpp?.[ab]?.[W] ?? null;
}

function normPosForDvp(pos) {
  const P = String(pos || '').toUpperCase();
  if (P === 'D/ST' || P === 'DST' || P === 'DEF') return 'DST';
  return P;
}

async function fetchDvpMap(origin, season) {
  try {
    const res = await fetch(`${origin}/api/dvp?season=${season}`, { redirect: 'follow' });
    if (!res.ok) return {};
    const data = await res.json().catch(() => ({}));
    return data?.map || data?.data || data || {};
  } catch {
    return {};
  }
}

// Batch your own /api/opponent to fill missing opponents (rare)
async function fetchOpponentMap(origin, { leagueId, season, week }, teamAbbrs) {
  const uniq = [...new Set(teamAbbrs)].filter(Boolean);
  if (!uniq.length) return {};
  const makeUrl = (t) =>
    `${origin}/api/opponent?leagueId=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}&week=${encodeURIComponent(week)}&teamAbbr=${encodeURIComponent(t)}`;

  const results = await Promise.allSettled(uniq.map(t => fetch(makeUrl(t)).then(r => r.json())));
  const map = {};
  results.forEach((r, i) => {
    const team = uniq[i];
    if (r.status === 'fulfilled' && r.value?.ok && r.value?.opponent) {
      map[team] = normTeam(r.value.opponent);
    }
  });
  return map;
}

/* --------------------------------- ESPN API ---------------------------------- */

const HOSTS = {
  reads: 'https://lm-api-reads.fantasy.espn.com',
  main:  'https://fantasy.espn.com'
};

async function tryHost(hostKey, leagueId, season, week, swid, s2, wantRaw = false) {
  const base = HOSTS[hostKey];
  const url  = `${base}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_player_info&scoringPeriodId=${week}`;

  const cookieHeader = `SWID="${swid}"; espn_s2=${s2}`;
  const referer = `https://fantasy.espn.com/football/league?leagueId=${leagueId}&seasonId=${season}`;

  const res = await fetch(url, {
    headers: {
      cookie: cookieHeader,
      "x-fantasy-filter": JSON.stringify({
        players: {
          filterStatus: { value: ["ONTEAM","WAIVERS","FREEAGENT"] },
          filterSlotIds: { value: SLOT_IDS },
          sortPercOwned: { sortAsc: false, sortPriority: 1 },
          limit: 5000,
        },
      }),
      "x-fantasy-source": "kona",
      "x-fantasy-platform": "kona-PROD",
      "accept": "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0",
      "referer": referer,
      "origin": "https://fantasy.espn.com",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
    },
    redirect: "follow",
  });

  const ctype = res.headers.get("content-type") || "";
  if (wantRaw || !ctype.includes("application/json")) {
    const body = await res.text();
    return { host: hostKey, ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), body, cookieHeader };
  }
  const data = await res.json();
  return { host: hostKey, ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), data, cookieHeader };
}

/* ----------------------------- FantasyPros CSVs ------------------------------ */

const FP_RANK_CSV_BASE = "/fp";
const RANK_POSITIONS = ["QB","RB","WR","TE","K","DST"];

// CSV line splitter (handles quotes/commas)
function splitCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) { out.push(cur); cur = ""; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

async function fetchRankCsvMap(origin, season, week, pos) {
  const pos2 = rankPos(pos);
  const buildUrl = (w) => `${origin}${FP_RANK_CSV_BASE}/FantasyPros_${season}_Week_${w}_${pos2}_Rankings.csv`;

  const W = Number(week);
  const tryWeeks = (Number.isInteger(W) && W >= 1 && W <= 18)
    ? Array.from({ length: W }, (_, i) => W - i) // W,W-1,...,1
    : [week];

  let text = "", usedWeek = null;
  for (const w of tryWeeks) {
    try {
      const res = await fetch(buildUrl(w), { headers: { accept: "text/csv,text/plain,*/*" }, redirect: "follow" });
      if (!res.ok) continue;

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const t  = await res.text();

      const looksHtml = t.trim().startsWith("<") || ct.includes("text/html");
      const isCsvish  = ct.includes("csv") || ct.includes("text/plain");

      if (looksHtml) continue;
      if (!t || !t.trim()) continue;
      if (!isCsvish) {
        const firstLine = t.split(/\r?\n/, 1)[0] || "";
        if (!(firstLine.includes(",") && /rk|player/i.test(firstLine))) continue;
      }

      text = t;
      usedWeek = w;
      break;
    } catch {}
  }

  if (!text) return { map: {}, usedWeek: null };

  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { map: {}, usedWeek: null };

  const header = splitCsvLine(lines[0]).map(h => String(h).trim());
  const findIdx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const rkIdx = findIdx("RK");
  const playerIdx = (() => {
    const i1 = findIdx("PLAYER NAME"); if (i1 >= 0) return i1;
    const i2 = findIdx("Player");      if (i2 >= 0) return i2;
    return 0;
  })();

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map(c => String(c).trim());
    if (!cells.length) continue;

    const name = cells[playerIdx] || "";
    if (!name) continue;

    let rank = null;
    if (rkIdx >= 0) {
      const r = Number((cells[rkIdx] || '').replace(/[^\d.]/g, ""));
      if (Number.isFinite(r) && r > 0) rank = r;
    }
    if (rank === null) {
      const r = Number((cells[0] || '').replace(/[^\d.]/g, ""));
      if (Number.isFinite(r) && r > 0) rank = r;
    }
    if (rank === null) continue;

    out[`${pos2}:${name}`] = rank;
  }

  return { map: out, usedWeek };
}

async function fetchRanksFromCsv(origin, season, week) {
  const results = await Promise.all(RANK_POSITIONS.map(p => fetchRankCsvMap(origin, season, week, p)));
  const ranks = {}; const usedByPos = {};
  results.forEach((res, idx) => {
    Object.assign(ranks, res.map);
    usedByPos[RANK_POSITIONS[idx]] = res.usedWeek;
  });
  const usedWeek = Object.values(usedByPos)
    .reduce((max, w) => (w && (!max || w > max) ? w : max), null);
  return { ranks, usedWeek, usedByPos };
}

/* -------------------------------- bye weeks & schedules ---------------------------------- */

const _byeWeeksCache = new Map(); // season -> { BYE_MAP, fetchedAt }
const BYE_SS_KEY = (season) => `FF_BYE_WEEKS:${season}`;

async function fetchByeWeeks(origin, { season, leagueId, teamId }){
  const mem = _byeWeeksCache.get(season);
  if (mem?.BYE_MAP) return mem.BYE_MAP;

  try{
    const raw = sessionStorage.getItem(BYE_SS_KEY(season));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _byeWeeksCache.set(season, { BYE_MAP: parsed, fetchedAt: Date.now() });
        return parsed;
      }
    }
  }catch{}

  const params = new URLSearchParams({ season:String(season) });
  if (leagueId) params.set('leagueId', String(leagueId));
  if (teamId)   params.set('teamId',   String(teamId));

  try{
    const r = await fetch(`${origin}/api/bye-weeks?`+params.toString(), { cache:'no-store' });
    const j = await r.json().catch(()=>null);
    const map = (j && j.byeWeeks) || {};
    _byeWeeksCache.set(season, { BYE_MAP: map, fetchedAt: Date.now() });
    try{ sessionStorage.setItem(BYE_SS_KEY(season), JSON.stringify(map)); }catch{}
    return map;
  }catch{
    return {};
  }
}

// --- Build opponent + bye maps from proTeams blob ----------------------------
function normAbbr(s) {
  const x = String(s || '').toUpperCase();
  if (x === 'JAC') return 'JAX';
  if (x === 'WAS') return 'WSH';
  if (x === 'SD')  return 'LAC';
  if (x === 'OAK') return 'LV';
  if (x === 'LA' || x === 'STL') return 'LAR';
  return x;
}

// expects: { proTeams: [ { abbrev|abbreviation, id, byeWeek, proGamesByScoringPeriod: { "1":[{homeProTeamId,awayProTeamId}], ... } } ] }
function buildScheduleMapsFromProTeams(root, MAX_WEEKS = 18) {
  const proTeams = Array.isArray(root?.proTeams)
    ? root.proTeams
    : (Array.isArray(root?.settings?.proTeams) ? root.settings.proTeams : []);
  const byTeamWeekOpp = {};
  const byeMap = {};

  const ensureTeam = (abbr) => { if (!byTeamWeekOpp[abbr]) byTeamWeekOpp[abbr] = {}; };

  for (const t of proTeams) {
    const teamAbbr = normAbbr(t?.abbrev || t?.abbreviation);
    if (!teamAbbr) continue;

    ensureTeam(teamAbbr);
    if (Number.isInteger(t?.byeWeek)) byeMap[teamAbbr] = Number(t.byeWeek);

    const sched = (t?.proGamesByScoringPeriod && typeof t.proGamesByScoringPeriod === 'object')
      ? t.proGamesByScoringPeriod
      : {};

    // Fill known games
    for (const [wkStr, games] of Object.entries(sched)) {
      const W = Number(wkStr);
      if (!(W >= 1 && W <= MAX_WEEKS)) continue;
      const g = Array.isArray(games) ? games[0] : null;      // at most one game per SPID
      if (!g) { byTeamWeekOpp[teamAbbr][W] = 'BYE'; continue; }

      const home = toAbbr(g.homeProTeamId);
      const away = toAbbr(g.awayProTeamId);
      const homeAb = normAbbr(home);
      const awayAb = normAbbr(away);

      if (!homeAb || !awayAb) continue;

      // write both directions; later teams will simply overwrite with same value
      ensureTeam(homeAb); ensureTeam(awayAb);
      byTeamWeekOpp[homeAb][W] = awayAb;
      byTeamWeekOpp[awayAb][W] = homeAb;
    }
  }

  // Fill explicit BYEs where the team has no entry for a week but we know its byeWeek
  for (const [team, wk] of Object.entries(byeMap)) {
    if (!byTeamWeekOpp[team]) byTeamWeekOpp[team] = {};
    if (!byTeamWeekOpp[team][wk]) byTeamWeekOpp[team][wk] = 'BYE';
  }

  return { byTeamWeekOpp, byeMap };
}

// --- NFL pro-team schedules (authoritative; works without cookies) -----------
// Example: https://fantasy.espn.com/apis/v3/games/ffl/seasons/2025?view=proTeamSchedules
async function fetchProTeamSchedulesJson(season) {
  const urls = [
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules_wl`,
    // backup host if reads is flaky:
    `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules_wl`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      if (r.ok) return await r.json().catch(() => null);
    } catch {}
  }
  return null;
}

/* --------------------------------- handler ----------------------------------- */

// 🔧 Include env so we can read ESPN_SWID / ESPN_S2
export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const leagueId  = url.searchParams.get("leagueId") || url.searchParams.get("league");
    const season    = toNum(url.searchParams.get("season"), new Date().getFullYear());
    const week      = clampWeek(url.searchParams.get("week") || url.searchParams.get("scoringPeriodId") || 1);
    const minProj   = 1;
    const MIN_POS_RANK = 1;
    const diag      = url.searchParams.get("diag") === "1";
    const credsFlag = url.searchParams.get("creds") === "1";
    const forceHost = (url.searchParams.get("host") || "").toLowerCase();
    const posParam  = (url.searchParams.get("pos") || "ALL").toUpperCase().trim();

    if (!leagueId) return json({ ok: false, error: "Missing leagueId" }, 400);

    // 1) Fetch season schedules JSON (cookie-free) and build maps
    const settingsJson = await fetchProTeamSchedulesJson(season);
    const { byTeamWeekOpp, byeMap } = buildScheduleMapsFromProTeams(settingsJson || {});
    const getByeWeek = (abbr) => {
      const w = byeMap[normTeam(abbr)];
      return Number.isInteger(w) ? w : null;
    };

    // ESPN auth (headers + env fallbacks)
    const { swid, s2 } = resolveCreds(request, url, env);
    if (!swid || !s2) return json({ ok: false, error: "Missing ESPN auth cookies (SWID / espn_s2)." }, 401);

    if (credsFlag) {
      const hdr = `SWID="${swid}"; espn_s2=${s2}`;
      return json({
        ok: true,
        seen: { SWID: mask(swid, 6, 6), espn_s2: mask(s2, 6, 6) },
        forwardingCookieHeader: hdr.replace(swid, mask(swid, 3, 3)).replace(s2, mask(s2, 3, 3)),
        note: "SWID must include braces and be quoted; espn_s2 must be fresh; account must have access to this league/season."
      });
    }

    // Ranks (safe on failure)
    let ranksMap = {}, usedRanksWeek = null, usedByPos = {};
    try {
      const ri = await fetchRanksFromCsv(url.origin, season, week);
      ranksMap      = ri.ranks || {};
      usedRanksWeek = ri.usedWeek ?? null;
      usedByPos     = ri.usedByPos || {};
    } catch {}

    // ESPN fetch: reads → main (unless forced)
    const order = forceHost === "reads" ? ["reads"]
                 : forceHost === "main"  ? ["main"]
                 : ["reads", "main"];

    let upstream = null, last = null;
    for (const key of order) {
      last = await tryHost(key, leagueId, season, week, swid, s2, diag);
      if (last.data && Array.isArray(last.data.players)) { upstream = last; break; }
      if (diag) {
        const bodySnippet = typeof last.body === "string" ? last.body.slice(0, 1200) : undefined;
        return json({
          ok: last.ok,
          hostTried: key,
          upstreamStatus: last.status,
          upstreamType: last.headers?.["content-type"],
          upstreamSnippet: bodySnippet,
          forwardedCookieHeader: last.cookieHeader?.replace(swid, mask(swid, 3, 3)).replace(s2, mask(s2, 3, 3)),
          hint: (last.headers?.["content-type"] || "").includes("html")
            ? "ESPN returned HTML (login/challenge or no league access). Ensure cookies are for an account with access."
            : undefined
        }, last.ok ? 200 : 502);
      }
    }

    if (!upstream) {
      const bodySnippet = typeof last?.body === "string" ? last.body.slice(0, 300) : undefined;
      return json({
        ok: false,
        error: "Upstream did not return JSON players array from any host",
        lastHostTried: last?.host,
        upstreamStatus: last?.status,
        upstreamType: last?.headers?.["content-type"],
        upstreamSnippet: bodySnippet
      }, 502);
    }

    const dvpMap = await fetchDvpMap(url.origin, season).catch(() => ({}));
    const raw = upstream.data.players || [];

    // Pass 1: build base rows & collect which teams need opponent via /api/opponent (rare)
    const base = [];
    const missingOppTeams = new Set();

    for (const pl of raw) {
      const P         = pl?.player || {};
      const id        = Number(P.id);
      const name      = P.fullName || P.name || `${P.firstName || ""} ${P.lastName || ""}`.trim();
      const pos       = POS_BY_ID[Number(P.defaultPositionId)] || "UTIL";
      const proTeamId = Number(P.proTeamId);
      const teamAbbr  = normTeam(toAbbr(proTeamId) || P.proTeamAbbreviation || P.proTeam);
      const proj      = getProjectedPoints(pl, week);

      // NEW (authoritative from pro schedule):
      let opponentAbbr = byTeamWeekOpp[teamAbbr]?.[week] ?? null;
      // guard against schedule BYE mismatch
      if (opponentAbbr === "BYE" && getByeWeek(teamAbbr) !== week) {
        opponentAbbr = null;
      }
      if (!opponentAbbr && teamAbbr) missingOppTeams.add(teamAbbr);

      // positional rank (CSV)
      let posRank = null;
      const posKey = rankPos(pos);
      const tryKeys = [
        `${posKey}:${posKey === "DST" ? stripDstSuffix(name) : name}`,
        (posKey === "DST" && teamAbbr && TEAM_FULL_BY_ABBR[teamAbbr]) ? `${posKey}:${TEAM_FULL_BY_ABBR[teamAbbr]}` : null
      ].filter(Boolean);
      for (const k of tryKeys) {
        const v = ranksMap[k];
        if (Number.isFinite(v)) { posRank = Number(v); break; }
      }

      base.push({
        id,
        name,
        position: pos,
        proTeamId: Number.isFinite(proTeamId) ? proTeamId : null,
        teamAbbr,
        proj: Number.isFinite(proj) ? proj : 0,
        rank: Number.isFinite(posRank) ? posRank : null,    // positional rank (ECR)
        opponentAbbr,
        defensiveRank: null,                                // fill with DvP if opponent known
        byeWeek: getByeWeek(teamAbbr),
        fmv: null
      });
    }

    // Pass 1.5: fill missing opponents via your endpoint
    let oppMap = {};
    if (missingOppTeams.size) {
      oppMap = await fetchOpponentMap(url.origin, { leagueId, season, week }, [...missingOppTeams]).catch(() => ({}));
    }

    // Pass 2: DvP + FMV + fill opp
    for (const p of base) {
      if (!p.opponentAbbr && p.teamAbbr && oppMap[p.teamAbbr]) {
        p.opponentAbbr = oppMap[p.teamAbbr];
      }

      if (p.opponentAbbr && p.opponentAbbr !== 'BYE') {
        const key = `${normTeam(p.opponentAbbr)}|${normPosForDvp(p.position)}`;
        const dvp = Number(dvpMap?.[key]);
        if (Number.isFinite(dvp)) p.defensiveRank = dvp;
      }

      if (Number.isFinite(p.proj) && p.proj > 0 && Number.isFinite(p.rank) && Number.isFinite(p.defensiveRank)) {
        p.fmv = Math.round(computeFMV_og(p.rank, p.defensiveRank, p.position));
      }
    }

    // Filters
    let filtered = base
      .filter(p => Number(p.proj) >= minProj)
      .filter(p => !(Number.isFinite(p.rank) && p.rank < 1)) // drop rank < 1 when present
      .filter(p => !(Number.isFinite(p.fmv) && p.fmv < 1 && p.fmv > 1000));  // ✅ drop players with fmv < 1 (but keep null fmv)

    if (posParam && posParam !== "ALL") {
      filtered = filtered.filter(p => {
        if (posParam === "FLEX") return ["RB", "WR", "TE"].includes(p.position);
        return p.position === posParam;
      });
    }

    // Sort: projection desc (stable)
    filtered.sort((a, b) => Number(b.proj || 0) - Number(a.proj || 0));

    return json({
      ok: true,
      meta: {
        leagueId: String(leagueId),
        season,
        week,
        usedWeek: usedRanksWeek,
        usedByPos,
        slotIds: SLOT_IDS,
        statuses: ["ONTEAM","WAIVERS","FREEAGENT"],
        minProj,
        fetchedAt: new Date().toISOString(),
        host: upstream.host,
        pos: posParam || "ALL"
      },
      count: filtered.length,
      players: filtered
    });

  } catch (err) {
    return json({
      ok: false,
      error: "Unhandled exception in all-players",
      detail: String((err && err.stack) || err)
    }, 502);
  }
};
