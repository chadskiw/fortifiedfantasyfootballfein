// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

// ====== Week helpers =======================================================
const NFL_MAX_WEEK  = 18;
const DEFAULT_WEEK  = Number(process.env.CURRENT_WEEK || 7);
function safeWeek(req) {
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp;
  const w = Number(raw);
  return Number.isFinite(w) && w >= 1 ? Math.min(w, NFL_MAX_WEEK) : DEFAULT_WEEK;
}
function teamTotalsFor(players) {
  let proj = 0, projRaw = 0, actual = 0, hasActuals = false, starters = 0;
  for (const p of players) {
    proj        += Number(p?.projApplied ?? (p?.isStarter ? (p?.proj ?? 0) : 0));
    projRaw     += Number(p?.proj_raw   ?? 0);                 // totals the raw weekly proj (bye => 0 now)
    actual      += Number(p?.appliedPoints ?? 0);              // zero-filled starter totals
    hasActuals ||= !!p?.hasActual;
    if (p?.isStarter) starters++;
  }
  return { proj, proj_raw: projRaw, actual, hasActuals, starters };
}

// ====== ESPN fetch =========================================================
async function espnGET(url, cand) {
  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    'accept': 'application/json',
    'user-agent': 'ff-platform-service/1.0',
    'x-fantasy-platform': 'web',
    'x-fantasy-source':   'kona'
  };
  const cookie = cand?.s2 && cand?.swid ? `espn_s2=${cand.s2}; SWID=${cand.swid};` : '';
  const resp = await fetch(url, cookie ? { headers: { ...headers, cookie } } : { headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, json, text };
}

// ====== Mapping helpers ====================================================
const TEAM_ABBR = {1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'};
const TEAM_FULL_NAMES = {
  ATL:'Atlanta Falcons',
  BUF:'Buffalo Bills',
  CHI:'Chicago Bears',
  CIN:'Cincinnati Bengals',
  CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys',
  DEN:'Denver Broncos',
  DET:'Detroit Lions',
  GB:'Green Bay Packers',
  TEN:'Tennessee Titans',
  IND:'Indianapolis Colts',
  KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders',
  LAR:'Los Angeles Rams',
  MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings',
  NE:'New England Patriots',
  NO:'New Orleans Saints',
  NYG:'New York Giants',
  NYJ:'New York Jets',
  PHI:'Philadelphia Eagles',
  ARI:'Arizona Cardinals',
  PIT:'Pittsburgh Steelers',
  LAC:'Los Angeles Chargers',
  SF:'San Francisco 49ers',
  SEA:'Seattle Seahawks',
  TB:'Tampa Bay Buccaneers',
  WSH:'Washington Commanders',
  CAR:'Carolina Panthers',
  JAX:'Jacksonville Jaguars',
  BAL:'Baltimore Ravens',
  HOU:'Houston Texans'
};
const TEAM_NAME_BY_ID = Object.fromEntries(Object.entries(TEAM_ABBR).map(([id, abbr]) => [Number(id), TEAM_FULL_NAMES[abbr] || abbr]));
const POS       = {1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST'};
const SLOT      = {0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'};

const FP_RANK_CSV_BASE = '/fp';
const CACHE_TTL_MS = 15 * 60 * 1000;
const HISTORY_LIMIT_DEFAULT = 4;
const DVP_CACHE = new Map();
const ECR_CACHE = new Map();
let fetchModulePromise = null;

async function getFetch() {
  if (typeof global.fetch === 'function') return global.fetch.bind(global);
  if (!fetchModulePromise) {
    fetchModulePromise = import('node-fetch').then(mod => mod.default);
  }
  return fetchModulePromise;
}

function roundTo(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function rankPos(pos = '') {
  const p = String(pos || '').toUpperCase();
  if (p === 'D/ST' || p === 'DST' || p === 'DST/DEF' || p === 'DEF' || p === 'D') return 'DST';
  if (p === 'PK') return 'K';
  return p;
}

function stripDstSuffix(name = '') {
  return String(name || '')
    .replace(/\bD\/ST\b|\bDST\b|\bDefense\b|\bSpecial\s*Teams\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normPosForDvp(pos) {
  return rankPos(pos);
}

function splitCsvLine(line = '') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else if (ch === '\r') {
      continue;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function fetchRankCsvMap(origin, season, week, pos) {
  if (!origin || !season) return { map: {}, usedWeek: null };
  const posCanon = rankPos(pos);
  const buildUrl = (w) => `${origin}${FP_RANK_CSV_BASE}/FantasyPros_${season}_Week_${w}_${posCanon}_Rankings.csv`;
  const W = Number(week);
  const tryWeeks = Number.isInteger(W) && W >= 1 && W <= NFL_MAX_WEEK
    ? Array.from({ length: W }, (_, i) => W - i)
    : [week];
  const fetchImpl = await getFetch();
  let text = '';
  let usedWeek = null;
  for (const w of tryWeeks) {
    try {
      const res = await fetchImpl(buildUrl(w), { headers: { accept: 'text/csv,text/plain,*/*' }, redirect: 'follow' });
      if (!res.ok) continue;
      const body = await res.text();
      const ct = (res.headers?.get ? res.headers.get('content-type') : '') || '';
      const looksHtml = body.trim().startsWith('<') || ct.toLowerCase().includes('text/html');
      if (looksHtml || !body.trim()) continue;
      text = body;
      usedWeek = w;
      break;
    } catch {}
  }
  if (!text) return { map: {}, usedWeek: null };

  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { map: {}, usedWeek: null };
  const header = splitCsvLine(lines[0]).map(h => String(h).trim());
  const findIdx = (name) => header.findIndex(h => h.toLowerCase() === String(name).toLowerCase());
  const rkIdx = findIdx('RK');
  const playerIdx = (() => {
    const idx1 = findIdx('PLAYER NAME');
    if (idx1 >= 0) return idx1;
    const idx2 = findIdx('Player');
    return idx2 >= 0 ? idx2 : 0;
  })();

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map(c => String(c).trim());
    if (!cells.length) continue;
    const name = cells[playerIdx];
    if (!name) continue;
    let rankVal = null;
    if (rkIdx >= 0) {
      const parsed = Number((cells[rkIdx] || '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) rankVal = parsed;
    }
    if (rankVal == null) {
      const fallback = Number((cells[0] || '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(fallback) && fallback > 0) rankVal = fallback;
    }
    if (rankVal == null) continue;
    out[`${posCanon}:${name}`] = rankVal;
  }

  return { map: out, usedWeek };
}

async function fetchRanksFromCsv(origin, season, week) {
  const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
  const results = await Promise.all(POSITIONS.map(pos => fetchRankCsvMap(origin, season, week, pos)));
  const ranks = {};
  const usedByPos = {};
  results.forEach((res, idx) => {
    Object.assign(ranks, res.map);
    usedByPos[POSITIONS[idx]] = res.usedWeek ?? null;
  });
  const usedWeek = Object.values(usedByPos)
    .reduce((max, w) => (w && (!max || w > max) ? w : max), null);
  return { ranks, usedWeek, usedByPos };
}

async function loadEcrMap(origin, season, week) {
  if (!origin || !season) return { ranks: {}, usedWeek: null, usedByPos: {} };
  const key = `${origin}|${season}|${week || 'all'}`;
  const cached = ECR_CACHE.get(key);
  if (cached) {
    if (cached.data && (!cached.expires || cached.expires > Date.now())) return cached.data;
    if (cached.promise) return cached.promise;
  }
  const promise = (async () => {
    try {
      const data = await fetchRanksFromCsv(origin, season, week);
      const out = { ranks: data.ranks || {}, usedWeek: data.usedWeek ?? null, usedByPos: data.usedByPos || {} };
      ECR_CACHE.set(key, { data: out, expires: Date.now() + CACHE_TTL_MS });
      return out;
    } catch {
      const out = { ranks: {}, usedWeek: null, usedByPos: {} };
      ECR_CACHE.set(key, { data: out, expires: Date.now() + CACHE_TTL_MS });
      return out;
    }
  })();
  ECR_CACHE.set(key, { promise });
  return promise;
}

async function loadDvpMap(origin, season) {
  if (!origin || !season) return {};
  const key = `${origin}|${season}`;
  const cached = DVP_CACHE.get(key);
  if (cached) {
    if (cached.data && (!cached.expires || cached.expires > Date.now())) return cached.data;
    if (cached.promise) return cached.promise;
  }
  const promise = (async () => {
    try {
      const fetchImpl = await getFetch();
      const url = new URL(`/api/dvp?season=${encodeURIComponent(season)}`, origin).toString();
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`dvp ${res.status}`);
      const json = await res.json().catch(() => ({}));
      const data = json?.map || json?.data || json || {};
      DVP_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
      return data;
    } catch {
      const data = {};
      DVP_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
      return data;
    }
  })();
  DVP_CACHE.set(key, { promise });
  return promise;
}

function buildProScheduleMaps(root, maxWeek = NFL_MAX_WEEK) {
  const proTeams = Array.isArray(root?.settings?.proTeams)
    ? root.settings.proTeams
    : Array.isArray(root?.proTeams)
    ? root.proTeams
    : [];
  const scheduleMap = {};
  const byeWeekMap = {};
  const ensure = (abbr) => {
    if (!abbr) return;
    if (!scheduleMap[abbr]) scheduleMap[abbr] = {};
  };
  for (const team of proTeams) {
    const abbr = String(team?.abbreviation || team?.abbrev || team?.teamAbbrev || '').toUpperCase();
    if (!abbr) continue;
    ensure(abbr);
    const byWeek = team?.proGamesByScoringPeriod || team?.schedule?.items || {};
    for (const [wkStr, value] of Object.entries(byWeek)) {
      const wk = Number(wkStr);
      if (!Number.isFinite(wk) || wk < 1 || wk > maxWeek) continue;
      const games = Array.isArray(value) ? value : (value ? [value] : []);
      if (!games.length) {
        scheduleMap[abbr][wk] = { opponent: 'BYE', homeAway: null, isBye: true };
        if (!byeWeekMap[abbr]) byeWeekMap[abbr] = wk;
        continue;
      }
      const game = games[0] || {};
      const homeId = Number(game.homeProTeamId ?? game.homeTeamId ?? game.homeProTeam ?? game.homeTeam?.id);
      const awayId = Number(game.awayProTeamId ?? game.awayTeamId ?? game.awayProTeam ?? game.awayTeam?.id);
      const homeAbbr = TEAM_ABBR[homeId];
      const awayAbbr = TEAM_ABBR[awayId];
      if (homeAbbr) {
        ensure(homeAbbr);
        scheduleMap[homeAbbr][wk] = { opponent: awayAbbr || null, homeAway: 'HOME', isBye: false };
      }
      if (awayAbbr) {
        ensure(awayAbbr);
        scheduleMap[awayAbbr][wk] = { opponent: homeAbbr || null, homeAway: 'AWAY', isBye: false };
      }
    }
  }
  return { scheduleMap, byeWeekMap };
}

function extractOpponentFromStats(stats, week) {
  if (!Array.isArray(stats)) return { opponent: null, homeAway: null, isBye: false };
  const wk = Number(week);
  if (!Number.isFinite(wk)) return { opponent: null, homeAway: null, isBye: false };
  const rows = stats.filter(s => Number(s?.scoringPeriodId) === wk);
  if (!rows.length) return { opponent: null, homeAway: null, isBye: false };
  const prefer = rows.find(r => Number(r?.statSourceId) === 0) || rows[0];
  if (!prefer) return { opponent: null, homeAway: null, isBye: false };
  const oppId = Number(prefer?.opponentProTeamId ?? prefer?.opponentTeamId ?? prefer?.opponentId ?? prefer?.opponent?.id);
  const opponent = TEAM_ABBR[oppId] || null;
  const haRaw = String(prefer?.homeAway || prefer?.homeOrAway || prefer?.location || '').toUpperCase();
  let homeAway = null;
  if (haRaw.startsWith('HOME') || haRaw === 'H') homeAway = 'HOME';
  else if (haRaw.startsWith('AWAY') || haRaw === 'A') homeAway = 'AWAY';
  const isBye = Boolean(prefer?.isBye || prefer?.byeWeek || prefer?.wasBye) && !opponent;
  return { opponent, homeAway, isBye };
}

function buildRecentWeekStats(stats, currentWeek, limit = HISTORY_LIMIT_DEFAULT) {
  if (!Array.isArray(stats) || limit <= 0) return [];
  const weekMap = new Map();
  for (const row of stats) {
    const wk = Number(row?.scoringPeriodId);
    if (!Number.isFinite(wk) || wk < 1) continue;
    const source = Number(row?.statSourceId);
    const val = Number(row?.appliedTotal ?? row?.appliedProjectedTotal ?? row?.totalProjectedPoints ?? row?.appliedAverage ?? row?.points);
    if (!Number.isFinite(val)) continue;
    let rec = weekMap.get(wk);
    if (!rec) {
      rec = { week: wk, proj: null, actual: null };
      weekMap.set(wk, rec);
    }
    if (source === 1) rec.proj = val;
    else if (source === 0) rec.actual = val;
  }
  const cutoff = Number(currentWeek);
  const rows = Array.from(weekMap.values())
    .filter(r => !Number.isFinite(cutoff) || r.week < cutoff)
    .sort((a, b) => b.week - a.week);
  const out = [];
  for (const rec of rows) {
    const proj = Number.isFinite(rec.proj) ? roundTo(rec.proj) : null;
    const actual = Number.isFinite(rec.actual) ? roundTo(rec.actual) : null;
    const delta = proj != null && actual != null ? roundTo(actual - proj) : null;
    out.push({ week: rec.week, proj, actual, delta });
    if (out.length >= limit) break;
  }
  return out;
}

function requestOrigin(req) {
  if (!req) return null;
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

function headshotFor(p, pos, abbr) {
  return p?.headshot?.href || p?.image?.href || p?.photo?.href ||
    (pos === 'DST' && abbr
      ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(abbr).toLowerCase()}.png&h=80&w=80&scale=crop`
      : (p?.id ? `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png` : '/img/placeholders/player.png'));
}

function pickProjected(stats, week) {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => Number(s?.statSourceId) === 1 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const any = stats.find(s => Number(s?.statSourceId) === 1 && Number.isFinite(+s.appliedTotal));
  return any ? +any.appliedTotal : null;
}

function pickActual(stats, week) {
  if (!Array.isArray(stats)) return null;
  // Only count the exact scoring period for statSourceId=0 (actuals). No fallbacks.
  const exact = stats.find(s =>
    Number(s?.statSourceId) === 0 &&
    Number(s?.scoringPeriodId) === Number(week) &&
    Number.isFinite(+s.appliedTotal)           // 0 is valid
  );
  return exact ? +exact.appliedTotal : null;   // null ⇒ “no actuals yet”
}


function teamNameOf(t) {
  return `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim()
      || t?.name
      || `Team ${t?.id}`;
}

function mapEntriesToPlayers(entries, week) {
  return entries.map(e => {
    const slotId = Number(e?.lineupSlotId);
    const slot   = SLOT[slotId] || 'BN';
    const isStarter = ![20,21].includes(slotId) && slot !== 'BN' && slot !== 'IR';

    const p     = e?.playerPoolEntry?.player || e.player || {};
    const pos   = POS[p?.defaultPositionId] || p?.defaultPosition || p?.primaryPosition || '';
    const abbr  = p?.proTeamAbbreviation || (p?.proTeamId ? TEAM_ABBR[p.proTeamId] : null);
    const stats = p?.stats || e?.playerStats || [];

    // Raw values from ESPN (may be null)
// inside mapEntriesToPlayers(...)
const projRaw = pickProjected(stats, week);                  // can be null on byes
const ptsRaw  = pickActual(stats, week);                     // null unless the WEEK row exists
const hasActual  = (ptsRaw != null);
const projZero   = projRaw == null ? 0 : Number(projRaw);    // bye ⇒ 0
const points     = hasActual ? Number(ptsRaw) : null;        // raw actuals (nullable)
const appliedPts = isStarter ? (points ?? 0) : 0;            // starter total (zero until live)
const projApplied= isStarter ? projZero : 0;

    // Season-to-date actual totals: prefer ESPN aggregate (scoringPeriodId=0),
    // otherwise inspect the per-week rows. Some leagues store the running season
    // total in week=1 (or cumulative per week), so detect monotonic growth and
    // fall back to the summed weekly totals only when the numbers actually
    // fluctuate.
    let seasonTotal = null;
    let derivedSource = null;
    if (Array.isArray(stats) && stats.length) {
      const actualRows = stats.filter(s => Number(s?.statSourceId) === 0 && Number.isFinite(+s?.appliedTotal));
      if (actualRows.length) {
        const aggregate = actualRows.find(s => Number(s?.scoringPeriodId) === 0);
        if (aggregate) {
          seasonTotal = Number(aggregate.appliedTotal);
          derivedSource = 'aggregate';
        } else {
          const weeklyRows = actualRows
            .filter(s => Number(s?.scoringPeriodId) > 0)
            .sort((a,b) => Number(a.scoringPeriodId) - Number(b.scoringPeriodId));
          if (weeklyRows.length) {
            let monotonic = true;
            let prev = null;
            for (const row of weeklyRows) {
              const val = Number(row.appliedTotal);
              if (!Number.isFinite(val)) continue;
              if (prev != null && val < prev - 0.001) { monotonic = false; break; }
              prev = val;
            }
            if (monotonic) {
              seasonTotal = Number((weeklyRows.at(-1)?.appliedTotal ?? 0));
              derivedSource = 'cumulative';
            } else {
              let sum = 0;
              for (const row of weeklyRows) {
                const val = Number(row.appliedTotal);
                if (Number.isFinite(val)) sum += val;
              }
              seasonTotal = sum;
              derivedSource = 'summed';
            }
          }
        }
      }
    }
const seasonPts = seasonTotal != null ? Number(seasonTotal.toFixed(2)) : null;

return {
  slot, isStarter,
      name: p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.name || '',
  position: pos,
  teamAbbr: abbr || '',
  proj: projZero,                  // now zero-filled
  points,                          // only set when week actual exists (0 allowed)
  appliedPoints: appliedPts,       // numeric always (starters zero-filled)
  headshot: headshotFor(p, pos, abbr),
  playerId: p?.id,
  lineupSlotId: slotId,

  // optional helpers you already added
  proj_raw: projRaw == null ? null : Number(projRaw),
  projApplied, hasActual, bye: (projRaw == null && ptsRaw == null),
  seasonPts,
  seasonActual: seasonPts != null && derivedSource !== null,
  seasonSource: derivedSource || null
};

  });
}


// ====== Route ==============================================================
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null && req.query.teamId !== '' ? Number(req.query.teamId) : null;
    const week     = safeWeek(req);

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // Build ESPN URL (single call covers teams, roster, settings, boxscore for week)
    const base   = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams({
      scoringPeriodId: String(week),
      matchupPeriodId: String(week)
    });
    params.append('view','mTeam');
    params.append('view','mRoster');
    params.append('view','mSettings');
    params.append('view','mBoxscore');
    const url = `${base}?${params.toString()}`;

    // Resolve ESPN cred candidates (server-side only)
    const cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId: Number.isFinite(teamId) ? teamId : null });

    // Try candidates in order; if all 401, try public once
    let used = null;
    let last = null;
    let data = null;

    if (Array.isArray(cands) && cands.length) {
      for (const cand of cands) {
        const r = await espnGET(url, cand);
        last = r;
        if (r.ok && r.json) { used = cand; data = r.json; break; }
        if (r.status !== 401) break; // hard-fail types
      }
    }

    if (!data) {
      // Public fallback (handles public leagues)
      const rPub = await espnGET(url, null);
      last = rPub;
      if (rPub.ok && rPub.json) {
        data = rPub.json;
        used = null; // public
      }
    }

    // If still nothing, emit meaningful error
    if (!data) {
      if (last?.status === 401 && cands?.length) {
        const first = cands[0];
        return res.status(401).json({
          ok: false,
          error: first?.stale ? 'espn_cred_stale' : 'espn_not_visible',
          hint:  first?.stale ? 'Please re-link ESPN (cookie expired)' : 'Creds exist but do not have access to this league',
        });
      }
      return res.status(last?.status || 500).json({
        ok:false, error:'upstream_error', detail: (last?.text || '').slice(0, 240)
      });
    }

    // Response headers for debugging
    try {
      res.set('x-espn-cred-source', used?.source || 'public');
      res.set('x-espn-cred-stale', used?.stale ? '1' : '0');
      if (used?.swid) res.set('x-ff-cred-swid', String(used.swid).slice(0, 12) + '…');
    } catch {}

    const teams = Array.isArray(data?.teams) ? data.teams : [];

    if (teamId != null && Number.isFinite(teamId)) {
      const t = teams.find(x => Number(x?.id) === Number(teamId));
      if (!t) return res.status(404).json({ ok:false, error:'team_not_found' });

const entries = t?.roster?.entries || [];
const players = mapEntriesToPlayers(entries, week);
const totals  = teamTotalsFor(players);

return res.json({
  ok: true, platform:'espn', leagueId, season, week,
  teamId, team_name: teamNameOf(t),
  totals,                 // <— NEW (non-breaking)
  players
});

    }

    // No teamId provided → return all teams with mapped players
// No teamId provided → return all teams with mapped players
const teamsOut = teams.map(t => {
  const teamId    = Number(t?.id);
  const team_name = teamNameOf(t);
  const entries   = t?.roster?.entries || [];
  const players   = mapEntriesToPlayers(entries, week);
  const totals    = teamTotalsFor(players);

  return { teamId, team_name, totals, players };
});

// Build quick lookup maps (back-compat for older consumers)
const ownership   = {};
const acquisition = {};
for (const t of teamsOut) {
  for (const pl of t.players || []) {
    if (pl.playerId != null) ownership[pl.playerId] = t.teamId;
    // if you later add pl.acquisitionType, this will populate:
    if (pl.acquisitionType)  acquisition[pl.playerId] = String(pl.acquisitionType).toUpperCase();
  }
}

// Respond once, outside of any map() callback
return res.json({
  ok: true,
  platform: 'espn',
  leagueId, season, week,
  teams: teamsOut,
  ownership,
  acquisition
});
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
