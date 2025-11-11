// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const fs      = require('fs/promises');
const path    = require('path');
const { resolveEspnCredCandidates } = require('./_cred');

// ====== Week helpers =======================================================
const NFL_MAX_WEEK  = 18;
const DEFAULT_WEEK  = Number(process.env.CURRENT_WEEK || null);
function safeWeek(req) {
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp;
  const w = Number(raw);
  return Number.isFinite(w) && w >= 1 ? Math.min(w, NFL_MAX_WEEK) : DEFAULT_WEEK;
}
function teamTotalsFor(players, { isSeasonScope = false } = {}) {
  let proj = 0, projRaw = 0, actual = 0, hasActuals = false, starters = 0;
  for (const p of players) {
    proj        += Number(p?.projApplied ?? (p?.isStarter ? (p?.proj ?? 0) : 0));
    projRaw     += Number(p?.proj_raw   ?? 0);                 // totals the raw weekly proj (bye => 0 now)
    if (isSeasonScope) {
      if (p?.isStarter) {
        const seasonVal = Number(p?.seasonPts ?? p?.points ?? 0);
        if (Number.isFinite(seasonVal)) {
          actual += seasonVal;
          hasActuals = true;
        } else {
          actual += Number(p?.appliedPoints ?? 0);
        }
      }
    } else {
      actual      += Number(p?.appliedPoints ?? 0);            // zero-filled starter totals
      hasActuals ||= !!p?.hasActual;
    }
    if (p?.isStarter) starters++;
  }
  if (isSeasonScope) hasActuals = true;
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
const TEAM_ABBR = {
  1:'ATL', 2:'BUF', 3:'CHI', 4:'CIN', 5:'CLE', 6:'DAL', 7:'DEN', 8:'DET',
  9:'GB', 10:'TEN', 11:'IND', 12:'KC', 13:'LV', 14:'LAR', 15:'MIA', 16:'MIN',
  17:'NE', 18:'NO', 19:'NYG', 20:'NYJ', 21:'PHI', 22:'ARI', 23:'PIT', 24:'LAC',
  25:'SF', 26:'SEA', 27:'TB', 28:'WSH', 29:'CAR', 30:'JAX',
  31:'BAL', 32:'HOU', 33:'BAL', 34:'HOU'
};
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
const TEAM_ABBR_BY_NAME = Object.fromEntries(
  Object.entries(TEAM_FULL_NAMES).map(([abbr, name]) => [String(name || '').toUpperCase(), abbr])
);
const TEAM_NAME_ALIASES = {
  'ARIZONA':'ARI',
  'ATLANTA':'ATL',
  'BALTIMORE':'BAL',
  'BUFFALO':'BUF',
  'CAROLINA':'CAR',
  'CHICAGO':'CHI',
  'CINCINNATI':'CIN',
  'CLEVELAND':'CLE',
  'DALLAS':'DAL',
  'DENVER':'DEN',
  'DETROIT':'DET',
  'GREEN BAY':'GB',
  'HOUSTON':'HOU',
  'INDIANAPOLIS':'IND',
  'JACKSONVILLE':'JAX',
  'KANSAS CITY':'KC',
  'LAS VEGAS':'LV',
  'LA CHARGERS':'LAC',
  'LA RAMS':'LAR',
  'LOS ANGELES CHARGERS':'LAC',
  'LOS ANGELES RAMS':'LAR',
  'MIAMI':'MIA',
  'MINNESOTA':'MIN',
  'NEW ENGLAND':'NE',
  'NEW ORLEANS':'NO',
  'NEW YORK GIANTS':'NYG',
  'NEW YORK JETS':'NYJ',
  'NEW YORK':'NYG',
  'PHILADELPHIA':'PHI',
  'PITTSBURGH':'PIT',
  'SAN FRANCISCO':'SF',
  'SEATTLE':'SEA',
  'TAMPA BAY':'TB',
  'TENNESSEE':'TEN',
  'WASHINGTON':'WSH',
  'WASHINGTON COMMANDERS':'WSH'
};
const TEAM_NAME_BY_ID = Object.fromEntries(Object.entries(TEAM_ABBR).map(([id, abbr]) => [Number(id), TEAM_FULL_NAMES[abbr] || abbr]));
const POS       = {1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST'};
const SLOT      = {0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'};

const FP_SEASON_CACHE = new Map();
const FP_SEASON_MISS  = new Set();
const DST_BACKFILLS = {
  WAS:'WSH', WSH:'WAS',
  JAC:'JAX', JAX:'JAC',
  LV:'LVR',  LVR:'LV',
  LAR:'LA',  LA:'LAR',
  ARI:'ARZ', ARZ:'ARI'
};
const ROOT_DIR = path.resolve(__dirname, '../../..');

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

const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/gi;

function normalizeNameForFp(raw) {
  if (!raw) return '';
  let s = String(raw)
    .toLowerCase()
    .replace(/[\.\']/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(NAME_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeScoringLabel(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  if (!upper) return null;
  if (['STD', 'STANDARD', 'CLASSIC'].includes(upper)) return 'STD';
  if (['PPR', 'FULL', 'FULL_PPR', 'FULLPPR'].includes(upper)) return 'PPR';
  if (['HALF', 'HALF_PPR', 'HALFPPR', '0.5', '0.5PPR', 'HALF-PPR'].includes(upper)) return 'HALF';
  return null;
}

function determineScoringLabel(req, data) {
  const queryPref = normalizeScoringLabel(
    req?.query?.scoring ??
    req?.query?.scoringFormat ??
    req?.query?.scoringType ??
    req?.query?.format
  );
  if (queryPref) return queryPref;

  const ppr = Number(data?.settings?.scoringSettings?.pointsPerReception);
  if (Number.isFinite(ppr)) {
    if (Math.abs(ppr - 1) < 1e-6) return 'PPR';
    if (Math.abs(ppr - 0.5) < 1e-6) return 'HALF';
    if (Math.abs(ppr) < 1e-6) return 'STD';
  }

  const typeRaw = String(
    data?.settings?.scoringSettings?.scoringType ||
    data?.settings?.scoringSettings?.playerRankTypeId ||
    data?.scoringType ||
    ''
  ).toUpperCase();
  if (typeRaw.includes('HALF')) return 'HALF';
  if (typeRaw.includes('PPR')) return 'PPR';

  return 'STD';
}

function buildFpIndex(rows = []) {
  const byId = new Map();
  const byKey = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const fpId = row.fpId ?? row.playerId ?? row.id;
    if (fpId != null) {
      const key = String(fpId);
      if (key) byId.set(key, row);
    }

    const pos = rankPos(row.position || row.pos || row.slot || '');
    if (!pos) continue;
    const team = String(row.team || row.teamAbbrev || row.proTeam || row.teamId || '').toUpperCase();
    const name = normalizeNameForFp(row.name || row.fullName || '');

    const primaryKey = pos === 'DST'
      ? `DST|${team}|`
      : `${pos}|${team}|${name}`;
    if (primaryKey && !byKey.has(primaryKey)) byKey.set(primaryKey, row);

    const teamlessKey = `${pos}||${name}`;
    if (name && !byKey.has(teamlessKey)) byKey.set(teamlessKey, row);

    if (pos === 'DST' && team) {
      const alt = DST_BACKFILLS[team];
      if (alt) {
        const altKey = `DST|${alt}|`;
        if (!byKey.has(altKey)) byKey.set(altKey, row);
      }
    }
  }

  return { byId, byKey };
}

function extractSeasonPoints(row) {
  if (!row || typeof row !== 'object') return null;
  const weeks = (row.weeks && typeof row.weeks === 'object')
    ? row.weeks
    : (row.week && typeof row.week === 'object' ? row.week : null);
  if (weeks) {
    let total = 0;
    let seen = false;
    for (const val of Object.values(weeks)) {
      const num = Number(val);
      if (!Number.isFinite(num)) continue;
      total += num;
      seen = true;
    }
    if (seen) {
      if (!Number.isFinite(total) || Math.abs(total) < 1e-9) {
        const w1 = weeks['1'] ?? weeks[1];
        const first = Number(w1);
        if (Number.isFinite(first)) return first;
      }
      return total;
    }
  }
  const candidates = [
    row.seasonPoints,
    row.seasonPts,
    row.total,
    row.points,
    row.projectedSeasonPoints
  ];
  for (const cand of candidates) {
    const num = Number(cand);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

async function loadFpSeasonIndex(season, scoring) {
  if (!Number.isFinite(Number(season))) return null;
  const labels = [];
  const normalized = normalizeScoringLabel(scoring);
  if (normalized) labels.push(normalized);
  if (!labels.includes('STD')) labels.push('STD');

  for (const label of labels) {
    const key = `${season}|${label}`;
    if (FP_SEASON_CACHE.has(key)) {
      const cached = FP_SEASON_CACHE.get(key);
      if (cached) return cached;
      continue;
    }
    if (FP_SEASON_MISS.has(key)) continue;

    const filePath = path.join(ROOT_DIR, 'public', 'data', 'fp', String(season), `${label}.json`);
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const json = JSON.parse(text);
      const players = Array.isArray(json?.players) ? json.players : [];
      const idx = buildFpIndex(players);
      const payload = {
        season: Number(season),
        scoring: label,
        meta: json?.meta || {},
        players,
        ...idx
      };
      FP_SEASON_CACHE.set(key, payload);
      return payload;
    } catch (err) {
      FP_SEASON_CACHE.set(key, null);
      FP_SEASON_MISS.add(key);
    }
  }

  return null;
}

function findFpMatchForPlayer(player, fpIndex) {
  if (!player || !fpIndex) return null;

  const idCandidates = [
    player.fantasyProsId,
    player.fantasyProsPlayerId,
    player.fpId,
    player.fp_id,
    player.fpID
  ];
  for (const id of idCandidates) {
    if (id == null) continue;
    const key = String(id);
    if (!key) continue;
    const hit = fpIndex.byId.get(key);
    if (hit) return hit;
  }

  const pos = rankPos(player.position || player.pos || player.slot || '');
  if (!pos) return null;
  const teamAbbr = String(
    player.teamAbbr ||
    player.proTeamAbbr ||
    player.proTeam ||
    player.team ||
    TEAM_ABBR[Number(player.proTeamId)]
  ).toUpperCase();

  if (pos === 'DST') {
    if (teamAbbr) {
      const direct = fpIndex.byKey.get(`DST|${teamAbbr}|`);
      if (direct) return direct;
      const alt = DST_BACKFILLS[teamAbbr];
      if (alt) {
        const hit = fpIndex.byKey.get(`DST|${alt}|`);
        if (hit) return hit;
      }
    }
    const teamName = normalizeNameForFp(
      stripDstSuffix(player.teamName || TEAM_FULL_NAMES[teamAbbr] || player.name || '')
    );
    if (teamName) {
      const hit = fpIndex.byKey.get(`DST||${teamName}`);
      if (hit) return hit;
    }
    return null;
  }

  const name = normalizeNameForFp(player.name || player.fullName || '');
  const primary = `${pos}|${teamAbbr}|${name}`;
  let hit = fpIndex.byKey.get(primary);
  if (hit) return hit;

  if (teamAbbr) {
    const alias = TEAM_NAME_ALIASES[teamAbbr];
    if (alias) {
      hit = fpIndex.byKey.get(`${pos}|${alias}|${name}`);
      if (hit) return hit;
    }
  }

  hit = fpIndex.byKey.get(`${pos}||${name}`);
  return hit || null;
}

function applyFpSeasonTotals(players, fpIndex, { isSeasonScope = false } = {}) {
  if (!Array.isArray(players) || !players.length || !fpIndex) return;

  for (const player of players) {
    const match = findFpMatchForPlayer(player, fpIndex);
    if (!match) continue;
    const seasonPts = extractSeasonPoints(match);
    if (seasonPts == null) continue;
    const rounded = roundTo(seasonPts);

    if (match.fpId != null && player.fpId == null) {
      const fpIdNum = Number(match.fpId);
      player.fpId = Number.isFinite(fpIdNum) ? fpIdNum : match.fpId;
      player.fantasyProsId = player.fantasyProsId ?? player.fpId;
    }

    player.seasonPts = rounded;
    player.seasonActual = true;
    player.seasonSource = player.seasonSource || 'fp-season';

    if (isSeasonScope) {
      player.points = rounded;
      if (player.isStarter) player.appliedPoints = rounded;
      player.hasActual = true;
    }
  }
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

function computeFMV(posRank, dvp, position) {
  const rankVal = Number(posRank);
  const dvpVal = Number(dvp);
  if (!Number.isFinite(rankVal) || !Number.isFinite(dvpVal)) return null;
  const P = rankPos(position);
  let value;
  if (P === 'QB' || P === 'K' || P === 'DST') value = rankVal + dvpVal;
  else if (P === 'TE') value = (rankVal / 1.4) + dvpVal;
  else value = (rankVal / 2) + dvpVal;
  return Math.round(value);
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

function mapEntriesToPlayers(entries, week, ctx = {}) {
  const weekNum = Number(week);
  const schedule = ctx.schedule || ctx.oppByTeam || {};
  const byeWeekMap = ctx.byeWeekByTeam || ctx.byeWeekMap || {};
  const ranksMap = ctx.ranksMap && typeof ctx.ranksMap === 'object' ? ctx.ranksMap : {};
  const dvpMap = ctx.dvpMap && typeof ctx.dvpMap === 'object' ? ctx.dvpMap : {};
  const historyLimit = Number.isFinite(ctx.historyLimit) ? ctx.historyLimit : HISTORY_LIMIT_DEFAULT;
  const getRank = (key) => (ranksMap instanceof Map ? ranksMap.get(key) : ranksMap?.[key]);
  const getDvp = (key) => (dvpMap instanceof Map ? dvpMap.get(key) : dvpMap?.[key]);

  return entries.map(e => {
    const slotId = Number(e?.lineupSlotId);
    const slot = SLOT[slotId] || 'BN';
    const isStarter = ![20, 21].includes(slotId) && slot !== 'BN' && slot !== 'IR';

    const p = e?.playerPoolEntry?.player || e.player || {};
    const pos = POS[p?.defaultPositionId] || p?.defaultPosition || p?.primaryPosition || '';
    const proTeamId = Number(p?.proTeamId);
    const abbrRaw = p?.proTeamAbbreviation || (Number.isFinite(proTeamId) ? TEAM_ABBR[proTeamId] : null);
    const teamAbbr = abbrRaw ? String(abbrRaw).toUpperCase() : '';
    const stats = p?.stats || e?.playerStats || [];
    const rawFpId =
      p?.fantasyProsId ??
      p?.fantasyProsPlayerId ??
      e?.playerPoolEntry?.player?.fantasyProsId ??
      e?.playerPoolEntry?.player?.fantasyProsPlayerId ??
      null;
    let fpId = null;
    if (rawFpId != null && rawFpId !== '') {
      const fpNum = Number(rawFpId);
      fpId = Number.isFinite(fpNum) ? fpNum : String(rawFpId);
    }

    const projRaw = pickProjected(stats, weekNum);
    const ptsRaw = pickActual(stats, weekNum);
    const hasActual = ptsRaw != null;
    const projZero = projRaw == null ? 0 : Number(projRaw);
    const points = hasActual ? Number(ptsRaw) : null;
    const appliedPts = isStarter ? (points ?? 0) : 0;
    const projApplied = isStarter ? projZero : 0;

    let seasonTotal = null;
    let derivedSource = null;
    if (Array.isArray(stats) && stats.length) {
      const actualRows = stats.filter(s => Number(s?.statSourceId) === 0 && Number.isFinite(+s?.appliedTotal));
      if (actualRows.length) {
        const weeklyRows = actualRows.filter(s => Number(s?.scoringPeriodId) > 0);
        if (weeklyRows.length) {
          let sum = 0;
          for (const row of weeklyRows) {
            const val = Number(row.appliedTotal);
            if (Number.isFinite(val)) sum += val;
          }
          if (Number.isFinite(sum)) {
            seasonTotal = sum;
            derivedSource = 'summed';
          }
        }
        if (seasonTotal == null) {
          const aggregate = actualRows.find(s => Number(s?.scoringPeriodId) === 0);
          if (aggregate) {
            const aggVal = Number(aggregate.appliedTotal);
            if (Number.isFinite(aggVal) && Math.abs(aggVal) < 1e-6) {
              seasonTotal = 0;
              derivedSource = 'aggregate';
            }
          }
        }
      }
    }
    const seasonPts = seasonTotal != null ? roundTo(seasonTotal) : null;

    const scheduleForTeam = schedule?.[teamAbbr] || schedule?.[String(teamAbbr || '').toUpperCase()] || {};
    const scheduleEntry = scheduleForTeam?.[weekNum] ?? scheduleForTeam?.[String(weekNum)];
    const opponentCandidates = [];
    const homeAwayCandidates = [];
    const byeWeekCandidates = [];
    let scheduledBye = false;

    const mappedBye = byeWeekMap?.[teamAbbr];
    if (Number.isFinite(Number(mappedBye))) byeWeekCandidates.push(Number(mappedBye));

    if (scheduleEntry) {
      if (typeof scheduleEntry === 'string') {
        opponentCandidates.push(scheduleEntry);
        if (String(scheduleEntry).trim().toUpperCase() === 'BYE') scheduledBye = true;
      } else if (typeof scheduleEntry === 'object') {
        opponentCandidates.push(scheduleEntry.opponent);
        homeAwayCandidates.push(scheduleEntry.homeAway);
        if (scheduleEntry.isBye) scheduledBye = true;
      }
    }

    const statsFallback = extractOpponentFromStats(stats, weekNum);
    if (statsFallback.opponent) opponentCandidates.push(statsFallback.opponent);
    if (statsFallback.homeAway) homeAwayCandidates.push(statsFallback.homeAway);
    if (statsFallback.isBye) scheduledBye = true;

    opponentCandidates.push(
      p?.opponentAbbreviation,
      p?.opponentAbbrev,
      p?.opponent,
      p?.opponentTeamAbbrev,
      p?.opponentShortName,
      p?.matchup?.opponentTeamAbbrev,
      p?.matchup?.opponent?.teamAbbrev,
      p?.matchup?.opponent?.abbrev,
      p?.matchup?.opponent?.shortName,
      p?.gameProjection?.opponentTeamAbbrev,
      p?.gameProjection?.opponentAbbrev,
      p?.gameProjection?.opponentShortName,
      p?.upcomingOpponentAbbrev,
      p?.upcomingOpponent?.teamAbbrev,
      p?.upcomingOpponent?.abbrev,
      p?.upcomingOpponent,
      e?.opponentAbbrev,
      e?.opponent?.teamAbbrev,
      e?.opponent?.abbrev,
      e?.opponent?.shortName,
      TEAM_ABBR[Number(p?.matchup?.opponentTeamId)],
      TEAM_ABBR[Number(p?.opponentProTeamId)],
      TEAM_ABBR[Number(e?.opponentProTeamId)]
    );

    homeAwayCandidates.push(
      scheduleEntry && typeof scheduleEntry === 'object' ? scheduleEntry.homeAway : null,
      statsFallback.homeAway,
      p?.matchup?.homeAway,
      p?.matchup?.homeOrAway,
      p?.gameProjection?.homeAway,
      p?.gameProjection?.homeOrAway,
      p?.homeAway,
      p?.homeOrAway,
      e?.homeAway,
      e?.homeOrAway
    );

    byeWeekCandidates.push(
      p?.byeWeek,
      p?.player?.byeWeek,
      p?.schedule?.byeWeek,
      p?.proTeamByeWeek,
      e?.byeWeek
    );

    const normalizeOpponent = (val) => {
      if (val == null) return null;
      if (typeof val === 'number') {
        return TEAM_ABBR[Number(val)] || null;
      }
      let str = String(val).trim();
      if (!str) return null;
      str = str.replace(/[.,]$/, '');
      if (/^BYE$/i.test(str)) return 'BYE';
      str = str.replace(/^@/, '').trim();
      str = str.replace(/^(VS?\.?|V\.?)\s*/i, '');
      if (!str) return null;
      const compact = str.replace(/\s+/g, ' ').trim();
      const upper = compact.toUpperCase();
      if (compact.length <= 3) {
        if (TEAM_FULL_NAMES[upper]) return upper;
        return null;
      }
      const alias = TEAM_ABBR_BY_NAME[upper] || TEAM_NAME_ALIASES[upper];
      if (alias) return alias;
      return null;
    };

    const normalizeHomeAway = (val) => {
      if (val == null) return null;
      const upper = String(val).trim().toUpperCase();
      if (!upper) return null;
      if (upper === 'HOME' || upper === 'H' || upper === 'HOME_TEAM') return 'HOME';
      if (upper === 'AWAY' || upper === 'A' || upper === 'AWAY_TEAM' || upper === 'ROAD') return 'AWAY';
      return null;
    };

    const normalizeBye = (val) => {
      const num = Number(val);
      return Number.isFinite(num) && num > 0 ? num : null;
    };

    let opponentAbbr = null;
    for (const cand of opponentCandidates) {
      const norm = normalizeOpponent(cand);
      if (norm) { opponentAbbr = norm; break; }
    }

    let homeAway = null;
    for (const cand of homeAwayCandidates) {
      const norm = normalizeHomeAway(cand);
      if (norm) { homeAway = norm; break; }
    }

    let byeWeek = null;
    for (const cand of byeWeekCandidates) {
      const norm = normalizeBye(cand);
      if (norm != null) { byeWeek = norm; break; }
    }

    if ((scheduledBye || opponentAbbr === 'BYE') && !byeWeek && Number.isFinite(weekNum) && weekNum > 0) {
      byeWeek = weekNum;
    }
    if (byeWeek === weekNum && opponentAbbr !== 'BYE' && Number.isFinite(weekNum) && weekNum > 0) {
      opponentAbbr = 'BYE';
    }
    if (opponentAbbr === 'BYE') {
      homeAway = null;
    }

    let defensiveRank = null;
    if (opponentAbbr && opponentAbbr !== 'BYE' && pos) {
      const posKey = normPosForDvp(pos);
      const dvpVal = getDvp(`${opponentAbbr}|${posKey}`) ?? getDvp(`${opponentAbbr}|${rankPos(pos)}`);
      if (Number.isFinite(Number(dvpVal))) defensiveRank = Number(dvpVal);
    }

    let ecrRank = null;
    if (pos) {
      const posKey = rankPos(pos);
      if (posKey) {
        const nameCandidates = [
          p?.fullName,
          p?.name,
          [p?.firstName, p?.lastName].filter(Boolean).join(' ')
        ];
        if (posKey === 'DST' && teamAbbr) {
          nameCandidates.push(TEAM_FULL_NAMES[teamAbbr] || teamAbbr);
        }
        for (const candidate of nameCandidates) {
          const nm = posKey === 'DST' ? stripDstSuffix(candidate) : String(candidate || '');
          if (!nm) continue;
          const val = getRank(`${posKey}:${nm}`);
          if (Number.isFinite(Number(val))) { ecrRank = Number(val); break; }
        }
      }
    }

    const fmv = computeFMV(ecrRank, defensiveRank, pos);
    const recentWeeks = buildRecentWeekStats(stats, weekNum, historyLimit);
    const prev = recentWeeks.length ? recentWeeks[0] : null;
    const delta = (points != null && projRaw != null) ? roundTo(points - Number(projRaw)) : null;

    const fallbackTeamName = p?.proTeam?.name || p?.proTeam?.nickname || '';
    const teamName = teamAbbr
      ? (TEAM_FULL_NAMES[teamAbbr] || TEAM_NAME_BY_ID[proTeamId] || fallbackTeamName || '')
      : (TEAM_NAME_BY_ID[proTeamId] || fallbackTeamName || '');
    const opponentName = opponentAbbr && opponentAbbr !== 'BYE'
      ? (TEAM_FULL_NAMES[opponentAbbr] || opponentAbbr)
      : opponentAbbr || null;
    const statusTag = p?.injuryStatus || p?.status || null;

    return {
      slot,
      isStarter,
      name: p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.name || '',
      position: pos,
      teamAbbr: teamAbbr || '',
      proTeamAbbr: teamAbbr || '',
      proTeamId: Number.isFinite(proTeamId) ? proTeamId : null,
      teamName,
      opponent: opponentAbbr || null,
      opponentAbbr: opponentAbbr || null,
      opponentName,
      homeAway: homeAway || null,
      proj: projZero,
      points,
      delta,
      appliedPoints: appliedPts,
      headshot: headshotFor(p, pos, teamAbbr || abbrRaw || ''),
      playerId: p?.id,
      fpId,
      fantasyProsId: fpId,
      lineupSlotId: slotId,
      statusTag,
      oppAbbr: opponentAbbr || null,
      proj_raw: projRaw == null ? null : Number(projRaw),
      projApplied,
      hasActual,
      bye: (projRaw == null && ptsRaw == null) || opponentAbbr === 'BYE',
      byeWeek,
      seasonPts,
      seasonActual: seasonPts != null && derivedSource !== null,
      seasonSource: derivedSource || null,
      defensiveRank: defensiveRank != null ? defensiveRank : null,
      ecrRank: ecrRank != null ? ecrRank : null,
      fmv: fmv != null ? fmv : null,
      recentWeeks,
      prevWeek: prev?.week ?? null,
      prevProj: prev?.proj ?? null,
      prevActual: prev?.actual ?? null,
      prevDelta: prev?.delta ?? null
    };
  });
}
// ====== Route ==============================================================
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null && req.query.teamId !== '' ? Number(req.query.teamId) : null;
    const scopeRaw = String(req.query.scope || '').trim().toLowerCase();
    const weekHint = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp;
    const isSeasonScope = scopeRaw === 'season' || scopeRaw === 'full' || scopeRaw === 'year' || Number(weekHint) === 0;
    const week     = safeWeek(req);
    const rawWeekHintNum = Number(weekHint);
    const seasonWeek = Number.isFinite(rawWeekHintNum) && rawWeekHintNum > 0
      ? Math.min(Math.max(rawWeekHintNum, 1), NFL_MAX_WEEK)
      : 1;
    const effectiveWeek = isSeasonScope ? seasonWeek : week;

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // Build ESPN URL (single call covers teams, roster, settings, boxscore for week)
    const base   = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams({
      scoringPeriodId: String(effectiveWeek),
      matchupPeriodId: String(effectiveWeek)
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
    const scoringLabel = determineScoringLabel(req, data);
    const fpSeasonIndex = isSeasonScope ? await loadFpSeasonIndex(season, scoringLabel) : null;

    const origin = requestOrigin(req);
    let ecrInfo = { ranks: {}, usedWeek: null, usedByPos: {} };
    let dvpMap = {};
    if (Number.isFinite(season)) {
      const [ecrRes, dvpRes] = await Promise.allSettled([
        loadEcrMap(origin, season, effectiveWeek),
        loadDvpMap(origin, season)
      ]);
      if (ecrRes.status === 'fulfilled' && ecrRes.value) ecrInfo = ecrRes.value;
      if (dvpRes.status === 'fulfilled' && dvpRes.value) dvpMap = dvpRes.value;
    }
    const { scheduleMap, byeWeekMap } = buildProScheduleMaps(data, NFL_MAX_WEEK);
    const mapContext = {
      week: effectiveWeek,
      schedule: scheduleMap,
      byeWeekByTeam: byeWeekMap,
      ranksMap: ecrInfo.ranks,
      dvpMap,
      historyLimit: HISTORY_LIMIT_DEFAULT
    };
    const meta = {
      ecrWeek: ecrInfo.usedWeek ?? null,
      ecrUsedByPos: ecrInfo.usedByPos || {},
      dvpSeason: season,
      scoring: scoringLabel,
      espnWeek: effectiveWeek,
      scope: isSeasonScope ? 'season' : 'week'
    };
    if (fpSeasonIndex) {
      meta.fpSeason = {
        scoring: fpSeasonIndex.scoring,
        weeks: Array.isArray(fpSeasonIndex.meta?.weeks) ? fpSeasonIndex.meta.weeks : [],
        source: fpSeasonIndex.meta?.source || 'fp'
      };
    }
    try {
      if (ecrInfo.usedWeek != null) res.set('x-ff-ecr-week', String(ecrInfo.usedWeek));
    } catch {}

    if (teamId != null && Number.isFinite(teamId)) {
      const t = teams.find(x => Number(x?.id) === Number(teamId));
      if (!t) return res.status(404).json({ ok:false, error:'team_not_found' });

      const entries = t?.roster?.entries || [];
      const players = mapEntriesToPlayers(entries, effectiveWeek, mapContext);
      if (isSeasonScope && fpSeasonIndex) {
        applyFpSeasonTotals(players, fpSeasonIndex, { isSeasonScope: true });
      }
      const totals  = teamTotalsFor(players, { isSeasonScope });

      return res.json({
        ok: true, platform:'espn', leagueId, season, week: effectiveWeek,
        teamId, team_name: teamNameOf(t),
        totals,
        players,
        meta
      });
    }

    const teamsOut = teams.map(t => {
      const teamId = Number(t?.id);
      const team_name = teamNameOf(t);
      const entries = t?.roster?.entries || [];
      const players = mapEntriesToPlayers(entries, effectiveWeek, mapContext);
      if (isSeasonScope && fpSeasonIndex) {
        applyFpSeasonTotals(players, fpSeasonIndex, { isSeasonScope: true });
      }
      const totals = teamTotalsFor(players, { isSeasonScope });

      return { teamId, team_name, totals, players };
    });
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
  leagueId, season, week: effectiveWeek,
  teams: teamsOut,
  ownership,
  acquisition,
  meta
});
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
