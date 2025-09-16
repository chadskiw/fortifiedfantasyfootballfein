// functions/api/roster.js
// Fortified Fantasy — Roster API
// GET /api/roster?leagueId=&season=&teamId=&week=
//
// - Echoes `week` so headers never show "Week undefined".
// - Infers teamId from SWID owners if not provided.
// - Reads ESPN auth from headers, cookies, or query.
// - Host fallback: lm-api-reads → fantasy.espn.com
// - Classifies starters vs bench/IR correctly (FLEX is a starter).
// - ECR from FantasyPros CSVs (same origin /fp/*), DvP from /api/dvp,
//   FMV derived from (ECR, DvP), and byeWeek from /api/bye-weeks (key=proTeamAbbr).

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return { ok: res.ok, status: res.status, data, headers: Object.fromEntries(res.headers) };
  } catch {
    return { ok: false, status: res.status, data: text.slice(0, 2000), headers: Object.fromEntries(res.headers) };
  }
}

/* ------------------------------- ESPN auth -------------------------------- */

function normalizeSwid(s) {
  if (!s) return "";
  let sw = s.trim();
  try { sw = decodeURIComponent(sw); } catch {}
  sw = sw.replace(/^"+|"+$/g, "");
  if (!(sw.startsWith("{") && sw.endsWith("}"))) sw = `{${sw.replace(/^\{|\}$/g, "")}}`;
  return sw;
}

function readEspnAuth(request, url) {
  const h = request.headers;
  let swid = h.get("x-espn-swid") || "";
  let s2   = h.get("x-espn-s2")   || "";

  const cookie = h.get("cookie") || "";
  if (!swid) {
    const m = cookie.match(/SWID=([^;]+)/i);
    swid = m ? m[1] : "";
  }
  if (!s2) {
    const m = cookie.match(/(?:^|;\s*)(?:espn_s2|ESPN_S2)=([^;]+)/i);
    s2 = m ? m[1] : "";
  }

  const u = new URL(url);
  if (!swid) swid = u.searchParams.get("swid") || "";
  if (!s2)   s2   = u.searchParams.get("espn_s2") || u.searchParams.get("s2") || "";

  return { swid: normalizeSwid(swid), s2 };
}

/* --------------------------------- URLs ----------------------------------- */

const HOSTS = {
  reads: "https://lm-api-reads.fantasy.espn.com",
  main:  "https://fantasy.espn.com",
};

function teamsUrl(host, { leagueId, season }) {
  return `${host}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam`;
}
function rosterUrl(host, { leagueId, season, teamId }) {
  return `${host}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/teams/${teamId}?view=mRoster`;
}
// Public, no auth → schedule/opp lookup
function proSchedulesUrl(host, season) {
  return `${host}/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules_wl`;
}

/* -------------------------- maps / slot + position ------------------------- */

const TEAM_ABBR_BY_ID = {
  1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",
  10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",
  18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",
  26:"SEA",27:"TB",28:"WSH",29:"CAR",30:"JAX",31:"BAL",32:"HOU",33:"BAL",34:"HOU"
};
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

const POS_BY_DEFAULT_ID = { 1:"QB", 2:"RB", 3:"WR", 4:"TE", 5:"K", 16:"D/ST" };

function slotNameFromLineup(id) {
  const M = {
    0:"QB", 2:"RB", 3:"RB/WR", 4:"WR", 5:"WR/TE", 6:"TE", 7:"OP",
    16:"D/ST", 17:"K", 18:"P", 19:"HC", 20:"BE", 21:"IR", 23:"FLEX"
  };
  return M[Number(id)] ?? `SLOT_${id}`;
}
const isBenchOrIr = (slotId) => slotId === 20 || slotId === 21;

/* ----------------------------- projections helper -------------------------- */

function getProjectedPoints(entry, week) {
  const p = entry?.playerPoolEntry?.player;
  const stats = (p && Array.isArray(p.stats) && p.stats) || [];
  if (!stats.length) return null;

  const W = Number(week);
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const first = (...vals) => { for (const v of vals) if (v != null) return v; return null; };
  const valFrom = (r) => first(n(r?.appliedTotal), n(r?.appliedProjectedTotal), n(r?.totalProjectedPoints), n(r?.appliedAverage), n(r?.points));

  let row =
    stats.find(s => Number(s.scoringPeriodId) === W && Number(s.statSourceId) === 1 && Number(s.statSplitTypeId) === 1) ||
    stats.find(s => Number(s.scoringPeriodId) === W && Number(s.statSourceId) === 1) ||
    stats.find(s => Number(s.scoringPeriodId) === W);
  let v = row ? valFrom(row) : null;
  if (v != null) return v;

  const recentProj = stats.filter(s => Number(s.statSourceId) === 1)
    .sort((a,b) => Number(b.scoringPeriodId||0) - Number(a.scoringPeriodId||0))[0];
  v = recentProj ? valFrom(recentProj) : null;
  if (v != null) return v;

  for (const s of stats) { const t = valFrom(s); if (t != null) return t; }
  return null;
}

/* ------------------------ discover teamId from SWID ------------------------ */

async function tryFindMyTeamId(host, { leagueId, season, swid, s2 }) {
  const url = teamsUrl(host, { leagueId, season });
  const res = await fetchJson(url, {
    headers: {
      accept: "application/json",
      cookie: `SWID="${swid}"; espn_s2=${s2}`,
      "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0",
    },
  });
  if (!res.ok) return null;

  const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
  const needle = (swid || "").toUpperCase().replace(/[{}]/g, "");
  for (const t of teams) {
    const owners = Array.isArray(t.owners) ? t.owners : [];
    for (const o of owners) {
      const oid = String(o || "").toUpperCase().replace(/[{}]/g, "");
      if (oid && (oid === needle || oid.includes(needle))) return t.id;
    }
  }
  return null;
}

/* -------------------------- pro-team schedule lookup ----------------------- */

function toAbbr(id) { return TEAM_ABBR_BY_ID[Number(id)] || null; }

function buildScheduleMapsFromProTeams(root, MAX_WEEKS = 18) {
  const proTeams = Array.isArray(root?.proTeams)
    ? root.proTeams
    : (Array.isArray(root?.settings?.proTeams) ? root.settings.proTeams : []);
  const byTeamWeekOpp = {};

  const ensure = (abbr) => { if (!byTeamWeekOpp[abbr]) byTeamWeekOpp[abbr] = {}; };

  for (const t of proTeams) {
    const abbr = String(t?.abbreviation || t?.abbrev || "").toUpperCase();
    if (!abbr) continue;
    ensure(abbr);

    const sched = t?.proGamesByScoringPeriod || {};
    for (const [wkStr, games] of Object.entries(sched)) {
      const W = Number(wkStr);
      if (!(W >= 1 && W <= MAX_WEEKS)) continue;

      const g = Array.isArray(games) ? games[0] : null;
      if (!g) { byTeamWeekOpp[abbr][W] = "BYE"; continue; }

      const home = toAbbr(g.homeProTeamId);
      const away = toAbbr(g.awayProTeamId);
      if (!home || !away) continue;

      ensure(home); ensure(away);
      byTeamWeekOpp[home][W] = away;
      byTeamWeekOpp[away][W] = home;
    }
  }
  return { byTeamWeekOpp };
}

async function fetchProTeamSchedulesJson(season) {
  const urls = [
    proSchedulesUrl(HOSTS.reads, season),
    proSchedulesUrl(HOSTS.main,  season),
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      if (r.ok) return await r.json().catch(() => null);
    } catch {}
  }
  return null;
}

/* ------------------------------ bye-weeks API ------------------------------ */

async function fetchByeWeeks(origin, season) {
  try {
    const r = await fetch(`${origin}/api/bye-weeks?season=${encodeURIComponent(season)}`, { redirect: "follow" });
    if (!r.ok) return {};
    const j = await r.json().catch(() => null);
    // Support { byeWeeks:{PHI:5} } or { data:{...} } or map itself
    const map = (j && (j.byeWeeks || j.data || j.map)) || j || {};
    return (map && typeof map === "object") ? map : {};
  } catch {
    return {};
  }
}

/* ----------------------------- DvP + ECR utils ----------------------------- */

const FP_RANK_CSV_BASE = "/fp"; // same-origin CSVs

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
function normPosForDvp(pos) {
  const P = String(pos || '').toUpperCase();
  return (P === 'D/ST' || P === 'DST' || P === 'DEF') ? 'DST' : P;
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
      const r = Number((cells[0] || '').replace(/[^\d.]/g, "")); // fallback first col
      if (Number.isFinite(r) && r > 0) rank = r;
    }
    if (rank === null) continue;

    out[`${pos2}:${name}`] = rank;
  }

  return { map: out, usedWeek };
}

async function fetchRanksFromCsv(origin, season, week) {
  const POSITIONS = ["QB","RB","WR","TE","K","DST"];
  const results = await Promise.all(POSITIONS.map(p => fetchRankCsvMap(origin, season, week, p)));
  const ranks = {}; const usedByPos = {};
  results.forEach((res, idx) => {
    Object.assign(ranks, res.map);
    usedByPos[POSITIONS[idx]] = res.usedWeek;
  });
  const usedWeek = Object.values(usedByPos)
    .reduce((max, w) => (w && (!max || w > max) ? w : max), null);
  return { ranks, usedWeek, usedByPos };
}

/* ------------------------------ FMV computation --------------------------- */

function computeFMV(posRank, dvp, position) {
  const P = rankPos(position);
  if (!Number.isFinite(posRank) || !Number.isFinite(dvp)) return null;
  let val;
  if (P === 'QB' || P === 'K' || P === 'DST') val = posRank + dvp;
  else if (P === 'TE')                         val = (posRank / 1.4) + dvp;
  else                                         val = (posRank / 2)   + dvp; // RB/WR (and anything else)
  return Math.round(val);
}

/* --------------------------------- shaping -------------------------------- */

function shapeRoster(root, week, oppMap, byeMap, ranksMap) {
  const entries = Array.isArray(root?.roster?.entries) ? root.roster.entries : [];
  const starters = [];
  const bench = [];
  const players = [];

  for (const e of entries) {
    const pp = e?.playerPoolEntry || {};
    const p  = pp?.player || {};
    const slotId   = Number(e?.lineupSlotId);
    const pos      = POS_BY_DEFAULT_ID[Number(p.defaultPositionId)] || null;
    const teamAbbr = TEAM_ABBR_BY_ID[p.proTeamId] || null;

    // from /api/bye-weeks map (key = proTeamAbbr)
    const seasonByeWeek = teamAbbr ? (byeMap?.[teamAbbr] ?? null) : null;

    // opponent for requested week (from pro schedule map)
    let opponent = null;
    if (Number.isInteger(week) && week >= 1 && week <= 18 && teamAbbr && oppMap) {
      const opp = oppMap?.[teamAbbr]?.[week] ?? null;
      if (opp === "BYE") opponent = "BYE";
      else if (opp)      opponent = opp;
      // if maps didn't carry BYE but byeWeek equals requested week → show BYE
      if (!opponent && seasonByeWeek && seasonByeWeek === week) opponent = "BYE";
    }

    // ECR join
    let ecrRank = null;
    if (ranksMap && pos) {
      const posKey = rankPos(pos);
      const name = p.fullName || p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim();
      const tryKeys = [
        `${posKey}:${posKey === "DST" ? stripDstSuffix(name) : name}`,
        (posKey === "DST" && teamAbbr && TEAM_FULL_BY_ABBR[teamAbbr]) ? `${posKey}:${TEAM_FULL_BY_ABBR[teamAbbr]}` : null
      ].filter(Boolean);
      for (const k of tryKeys) { const v = ranksMap[k]; if (Number.isFinite(v)) { ecrRank = Number(v); break; } }
    }

    // DvP from opponent+position
    let defensiveRank = null;
    if (opponent && opponent !== "BYE" && pos) {
      const key = `${opponent}|${normPosForDvp(pos)}`;
      const dvpGetter = ranksMap && ranksMap.__getDvp;
      if (typeof dvpGetter === "function") {
        const dvp = Number(dvpGetter(key));
        if (Number.isFinite(dvp)) defensiveRank = dvp;
      }
    }

    // projections (best-effort)
    const proj = getProjectedPoints(e, week);

    // FMV if we have ECR + DvP
    const fmv = computeFMV(ecrRank, defensiveRank, pos);

    const row = {
      id:                pp.id ?? p.id ?? null,
      name:              p.fullName || p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim(),
      position:          pos,
      defaultPositionId: p.defaultPositionId ?? null,
      proTeamId:         p.proTeamId ?? null,
      teamAbbr,
      slotId,
      slotName:          slotNameFromLineup(slotId),

      opponent,
      opponentAbbr: opponent || null,
      byeWeek: seasonByeWeek ?? null,

      proj:              Number.isFinite(proj) ? proj : null,
      ecrRank,
      defensiveRank,
      fmv
    };

    players.push(row);
    if (isBenchOrIr(slotId)) bench.push(row); else starters.push(row);
  }

  const teamName =
    (root?.team?.location && root?.team?.nickname)
      ? `${root.team.location} ${root.team.nickname}`
      : (root?.team?.nickname || null);

  return { starters, bench, players, teamName };
}

/* --------------------------------- handler -------------------------------- */

export async function onRequestGet({ request }) {
  try {
    const u = new URL(request.url);
    const leagueId = u.searchParams.get("leagueId") || u.searchParams.get("league");
    const season   = u.searchParams.get("season")   || u.searchParams.get("year");
    let   teamId   = u.searchParams.get("teamId")   || u.searchParams.get("tid");
    const weekRaw  = u.searchParams.get("week");
    const week     = weekRaw ? Number(weekRaw) : null; // echo back even if null
    const diag     = u.searchParams.get("diag") === "1";

    if (!leagueId || !season) {
      return json({ ok: false, error: "Missing required query params: leagueId, season" }, 400);
    }

    const { swid, s2 } = readEspnAuth(request, request.url);
    if (!swid || !s2) {
      return json(
        { ok: false, error: "Not linked. ESPN auth missing.", need: ["x-espn-swid", "x-espn-s2"] },
        401
      );
    }

    // Discover teamId (reads → main)
    if (!teamId) {
      teamId = await tryFindMyTeamId(HOSTS.reads, { leagueId, season, swid, s2 })
            || await tryFindMyTeamId(HOSTS.main,  { leagueId, season, swid, s2 });
      if (!teamId) {
        return json(
          { ok: false, error: "Unable to infer teamId from SWID owners.", leagueId, season },
          404
        );
      }
    }

    // Opponent map (public schedules)
    let oppMap = {};
    try {
      const schedJson = await fetchProTeamSchedulesJson(season);
      if (schedJson) oppMap = buildScheduleMapsFromProTeams(schedJson).byTeamWeekOpp || {};
    } catch {}

    // Bye weeks from your API (key = proTeamAbbr)
    const byeMap = await fetchByeWeeks(u.origin, season).catch(() => ({}));

    // ECR ranks + DvP
    let ranksMap = {};
    let usedRanksWeek = null;
    let usedByPos = {};
    try {
      const ri = await fetchRanksFromCsv(u.origin, season, week ?? 1);
      ranksMap      = ri.ranks || {};
      usedRanksWeek = ri.usedWeek ?? null;
      usedByPos     = ri.usedByPos || {};
    } catch {}
    const dvpMap = await fetchDvpMap(u.origin, season).catch(() => ({}));
    ranksMap.__getDvp = (key) => dvpMap[key];

    // Fetch roster (reads → main)
    const commonHeaders = {
      accept: "application/json",
      cookie: `SWID="${swid}"; espn_s2=${s2}`,
      "user-agent": "Mozilla/5.0 FortifiedFantasy/1.0",
      referer: `https://fantasy.espn.com/football/team?leagueId=${leagueId}`,
      origin: "https://fantasy.espn.com",
    };

    let r = await fetchJson(rosterUrl(HOSTS.reads, { leagueId, season, teamId }), { headers: commonHeaders });
    if (!r.ok) {
      r = await fetchJson(rosterUrl(HOSTS.main, { leagueId, season, teamId }), { headers: commonHeaders });
    }
    if (!r.ok) {
      return json({ ok: false, error: "Upstream ESPN error for roster", status: r.status, upstream: r.data }, 502);
    }

    const shaped = shapeRoster(r.data || {}, week, oppMap, byeMap, ranksMap);
    const resp = {
      ok: true,
      leagueId: String(leagueId),
      teamId: Number(teamId),
      season: Number(season),
      week,                                 // echo for header
      usedWeek: usedRanksWeek || week || null,
      usedByPos,
      teamName: shaped.teamName || undefined,
      counts: { starters: shaped.starters.length, bench: shaped.bench.length },
      starters: shaped.starters,
      bench: shaped.bench,
      players: shaped.players,
    };

    if (diag) {
      const mask = (t, a=6, b=6) => (t ? `${t.slice(0,a)}...${t.slice(-b)}` : "");
      resp._diag = {
        cookieEcho: `SWID="${mask(swid)}"; espn_s2=${mask(s2)}`,
        scheduleOpp: Object.keys(oppMap).length ? "ok" : "missing",
        byeWeeks: Object.keys(byeMap).length,
        ranksCount: Object.keys(ranksMap).length,
        dvpSample: Object.keys(dvpMap).slice(0, 3)
      };
    }

    return json(resp, 200, { "x-ff-source": "roster-fmv-byeapi" });
  } catch (err) {
    return json({ ok: false, error: "Unhandled exception in /api/roster", detail: String(err?.message || err) }, 500);
  }
}
