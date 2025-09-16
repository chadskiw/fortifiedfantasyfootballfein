// functions/api/fp-ranks.js
/**
 * Fetch FantasyPros Consensus Rankings and emit a rankMap.
 * Keys: NAME|TEAM|POS with POS in {QB,RB,WR,TE,K,D/ST}
 * type=AUTO → Try ECR, else latest WEEK with data (<= maxWeek).
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// ------------------------------
// Small helpers
// ------------------------------
const NFL_DEFAULT_MAX_WEEK = 18;
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// D/ST name → abbr
const DST_TEAM_MAP = {
  "Buffalo Bills":"BUF","Miami Dolphins":"MIA","New England Patriots":"NE","New York Jets":"NYJ",
  "Baltimore Ravens":"BAL","Cincinnati Bengals":"CIN","Cleveland Browns":"CLE","Pittsburgh Steelers":"PIT",
  "Houston Texans":"HOU","Indianapolis Colts":"IND","Jacksonville Jaguars":"JAX","Tennessee Titans":"TEN",
  "Denver Broncos":"DEN","Kansas City Chiefs":"KC","Las Vegas Raiders":"LV","Los Angeles Chargers":"LAC",
  "Dallas Cowboys":"DAL","New York Giants":"NYG","Philadelphia Eagles":"PHI","Washington Commanders":"WSH",
  "Chicago Bears":"CHI","Detroit Lions":"DET","Green Bay Packers":"GB","Minnesota Vikings":"MIN",
  "Atlanta Falcons":"ATL","Carolina Panthers":"CAR","New Orleans Saints":"NO","Tampa Bay Buccaneers":"TB",
  "Arizona Cardinals":"ARI","Los Angeles Rams":"LAR","San Francisco 49ers":"SF","Seattle Seahawks":"SEA"
};

// abbr → full name
const DST_ABBR_TO_NAME = Object.fromEntries(
  Object.entries(DST_TEAM_MAP).map(([full, abbr]) => [abbr, full])
);

// Normalize legacy codes
const PRO_FIX = { JAC:"JAX", WAS:"WSH", SD:"LAC", OAK:"LV", LA:"LAR" };
function fixTeam(s = "") {
  const up = String(s || "").toUpperCase().replace(/[^A-Z]/g, "");
  return PRO_FIX[up] || up;
}

// Positions
function canonPos(pos = "") {
  const p = String(pos).toUpperCase().replace(/[^A-Z/]/g, "");
  if (p === "DST" || p === "DEF" || p === "D" || p === "DST/DEF") return "D/ST";
  if (p === "PK") return "K";
  return p;
}
function fpParamPos(pos = "") { return canonPos(pos) === "D/ST" ? "DST" : canonPos(pos); }

// Keys
function makeKey(name = "", team = "", pos = "") {
  const cleanName = String(name)
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, "")
    .replace(/[^a-z\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return `${cleanName}|${fixTeam(team)}|${canonPos(pos)}`;
}

// Scoring
function normalizeScoring(s = "ppr") {
  const v = String(s).toLowerCase();
  if (v.startsWith("half")) return "HALF";
  if (v === "std" || v === "standard" || v === "nonppr") return "STD";
  return "PPR";
}

const DEFAULT_POS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

// Cookies
function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(raw);
  return m ? decodeURIComponent(m[1]) : "";
}

// Extract FP row
function extractPlayerFields(row = {}) {
  const name =
    row.player_name || row.name || row.full_name || row.player || row.team_name || "";

  const posRaw =
    (Array.isArray(row.player_positions) ? row.player_positions[0] : null) ||
    row.position || row.pos || row.fp_position || "";

  const pos = canonPos(posRaw);

  const team =
    row.nfl_team || row.team || row.player_team_id || row.player_team ||
    row.team_id || row.pro_team || "";

  const rank =
    row.rank_ecr ?? row.ecr ?? row.rank ?? row.rank_consensus ??
    row.rank_projection ?? row.overall_ecr ?? null;

  return { name, pos, team, rank };
}

// D/ST helpers
function deduceDstTeamAbbr(dstName, teamAbbr) {
  if (teamAbbr) {
    const fixed = fixTeam(teamAbbr);
    if (DST_ABBR_TO_NAME[fixed]) return fixed;
  }
  const mapped = DST_TEAM_MAP[dstName?.trim?.()];
  if (mapped) return mapped;

  if (typeof dstName === "string" && dstName) {
    const s = dstName.replace(/\s*D\/?ST|\s*DEFENSE|\s*DEF/gi, "").trim();
    const hit = DST_TEAM_MAP[s];
    if (hit) return hit;
  }
  return "";
}
function normalizeDstNameForKey(teamAbbr) {
  return DST_ABBR_TO_NAME[teamAbbr] || "";
}

// Parse positions
function parsePositionsParam(v) {
  if (!v) return [];
  return String(v).split(/[,\s]+/).map(s => canonPos(s)).filter(Boolean);
}

// Merge helper
function addRowsIntoRankMap(payload, posCanonRequested, rankMap) {
  const rows = Array.isArray(payload?.players) ? payload.players
            : Array.isArray(payload?.rankings) ? payload.rankings
            : Array.isArray(payload?.data) ? payload.data
            : [];

  let added = 0;
  for (const row of rows) {
    const { name, pos, team, rank } = extractPlayerFields(row);
    if (!name || rank == null) continue;
    const n = Number(rank);
    if (!Number.isFinite(n) || n <= 0) continue;

    const effectivePos = canonPos(pos || posCanonRequested);

    if (effectivePos === "D/ST") {
      const abbr = deduceDstTeamAbbr(name, team);
      const full = abbr ? normalizeDstNameForKey(abbr) : name;
      const key = makeKey(full || name, abbr, "D/ST");
      if (rankMap[key] == null || n < rankMap[key]) rankMap[key] = n;
      added++;
    } else {
      const key = makeKey(name, team, effectivePos);
      if (rankMap[key] == null || n < rankMap[key]) rankMap[key] = n;
      added++;
    }
  }
  return added;
}

/* ====================================================================== */

export const onRequest = async ({ request, env, waitUntil }) => {
  try {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    let season  = Number(url.searchParams.get("season") || new Date().getUTCFullYear());
    let week    = Number(url.searchParams.get("week") || 1);
    let scoring = url.searchParams.get("scoring") || "ppr";
    let type    = (url.searchParams.get("type") || "AUTO").toUpperCase(); // default AUTO
    let players = [];
    let body    = null;

    // Fallback controls
    let maxWeek  = num(url.searchParams.get("maxWeek"), NFL_DEFAULT_MAX_WEEK);
    let fallback = true; // allow WEEK fallback when ECR/ROS empty

    if (method === "POST") {
      body = await request.json().catch(() => ({}));
      if (body?.season)  season  = Number(body.season);
      if (body?.week)    week    = Number(body.week);
      if (body?.scoring) scoring = String(body.scoring);
      if (body?.type)    type    = String(body.type).toUpperCase();
      if (Array.isArray(body?.players)) players = body.players;
      if (body?.maxWeek != null) maxWeek = num(body.maxWeek, NFL_DEFAULT_MAX_WEEK);
      if ("fallback" in body) {
        const b = body.fallback;
        fallback = !(b === 0 || b === false || String(b).toLowerCase() === "false");
      }
    }
    const qFallback = url.searchParams.get("fallback");
    if (qFallback != null)
      fallback = qFallback !== "0" && qFallback.toLowerCase() !== "false";

    maxWeek = Math.max(1, Math.min(25, maxWeek));

    // Positions
    let positions = parsePositionsParam(url.searchParams.get("positions") || url.searchParams.get("position")) || [];
    if (!positions.length && method === "POST") {
      positions = parsePositionsParam(
        (typeof body?.positions === "string" && body.positions) ||
        (Array.isArray(body?.positions) && body.positions.join(",")) ||
        body?.position
      );
    }
    if (!positions.length && Array.isArray(players) && players.length) {
      const set = new Set();
      for (const p of players) {
        const ps = canonPos(p?.pos || p?.position || "");
        if (ps) set.add(ps);
      }
      positions = [...set];
    }
    if (!positions.length) positions = DEFAULT_POS.slice();

    // API key
    const keyHeader = request.headers.get("x-fp-key") || "";
    const keyCookie = readCookie(request, "fp_key") || "";
    const apiKey = (env && env.FANTASYPROS_API_KEY) || keyHeader || keyCookie;
    if (!apiKey) {
      return json({ ok:false, error:"missing_key",
        hint:"Provide FantasyPros API key via env.FANTASYPROS_API_KEY, x-fp-key header, or fp_key cookie."
      }, 401);
    }

    const SPORT = "nfl";
    const SCOR  = normalizeScoring(scoring);
    const base  = `https://api.fantasypros.com/public/v2/json/${SPORT}/${season}/consensus-rankings`;

    async function fetchPositionOnce(posCanon, opt = {}) {
      const _type = (opt.type || type);
      const _week = String(opt.week ?? week);
      const q = new URLSearchParams({
        position: fpParamPos(posCanon),
        type: _type === "AUTO" ? "ECR" : _type,
        scoring: SCOR,
        week: _week
      });
      const req = new Request(`${base}?${q.toString()}`, {
        headers: { "x-api-key": apiKey, "accept":"application/json" }
      });

      const cacheKey = new Request(req.url, { method:"GET", headers:req.headers });
      const cache = caches.default;
      let res = await cache.match(cacheKey);
      if (!res) {
        res = await fetch(req);
        if (res.ok) {
          const r2 = new Response(res.body, res);
          r2.headers.set("Cache-Control", "public, max-age=10800");
          waitUntil(cache.put(cacheKey, r2.clone()));
          return r2;
        }
      }
      return res;
    }

    const rankMap = Object.create(null);
    let totalRows = 0;

    for (const posCanon of positions) {
      let addedForPos = 0;

      const tryOnce = async (t, w) => {
        const res = await fetchPositionOnce(posCanon, { type: t, week: w });
        if (res?.ok) {
          let payload; try { payload = await res.json(); } catch {}
          if (payload) return addRowsIntoRankMap(payload, posCanon, rankMap);
        }
        return 0;
      };

      if (type === "AUTO") {
        // ECR first
        addedForPos += await tryOnce("ECR", week);
        // then fallback to highest WEEK with data (start from requested week)
        if (addedForPos === 0) {
          for (let w = Math.min(maxWeek, Math.max(1, week)); w >= 1; w--) {
            const got = await tryOnce("WEEK", w);
            addedForPos += got;
            if (got > 0) break;
          }
        }
      } else {
        // Explicit type
        addedForPos += await tryOnce(type, week);

        // If ECR/ROS empty and fallback enabled → WEEK fallback
        if (fallback && addedForPos === 0 && (type === "ECR" || type === "ROS")) {
          for (let w = Math.min(maxWeek, Math.max(1, week)); w >= 1; w--) {
            const got = await tryOnce("WEEK", w);
            addedForPos += got;
            if (got > 0) break;
          }
        }
      }

      totalRows += addedForPos;
    }

    return json({
      ok: true,
      source: "fantasypros.consensus-rankings",
      season,
      week,
      scoring: String(SCOR).toLowerCase(),
      type,
      count: totalRows,
      rankMap
    });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
};
