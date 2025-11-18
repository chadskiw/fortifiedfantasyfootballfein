// routes/espn/free-agents.js
// Node 18+ for global fetch (AbortController). If older, polyfill as needed.
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const freeAgentsDirectModule = require('./free-agents-with-team');

const rawFaCorsList =
  process.env.FREE_AGENT_CORS_ALLOW || process.env.ROSTER_CORS_ALLOW || process.env.WIDGET_CORS_ALLOW || '';
const allowedFaCorsOrigins = rawFaCorsList
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

router.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (!allowedFaCorsOrigins.length || allowedFaCorsOrigins.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin && !allowedFaCorsOrigins.length) {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Vary', 'Origin');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Requested-With, X-ESPN-SWID, X-ESPN-S2, Authorization'
  );
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
const SELF_FREE_AGENTS_PATH = '/api/platforms/espn/free-agents';

const pullFreeAgentsDirectFn = typeof freeAgentsDirectModule?.pullFreeAgentsDirect === 'function'
  ? freeAgentsDirectModule.pullFreeAgentsDirect
  : null;
const normEspnPlayerFn = typeof freeAgentsDirectModule?.normEspnPlayer === 'function'
  ? freeAgentsDirectModule.normEspnPlayer
  : null;
const vWeekFn = typeof freeAgentsDirectModule?.vWeek === 'function'
  ? freeAgentsDirectModule.vWeek
  : null;

// Try these FA worker paths in order (configurable)
const RAW_FA_PATH_CANDIDATES = (
  process.env.FUNCTION_FREE_AGENTS_PATHS ||
  `${process.env.FUNCTION_FREE_AGENTS_PATH || ''},/api/platforms/espn/free-agents,/api/free-agents`
).split(',').map(s => s.trim()).filter(Boolean);
const SELF_PATH_NORMALIZED = normalizeRelativeFaPath(SELF_FREE_AGENTS_PATH) || SELF_FREE_AGENTS_PATH;
const PAGES_ORIGIN_ORIGIN = safeOrigin(PAGES_ORIGIN);
const FA_PATH_CANDIDATES = sanitizeFaPathCandidates(RAW_FA_PATH_CANDIDATES);

// Tunables
const PER_REQ_TIMEOUT_MS  = Number(process.env.FA_PER_REQ_TIMEOUT_MS || 1500);
const MAX_PAGES_PER_CALL  = Number(process.env.FA_MAX_PAGES || 12); // stop when a page is empty/short
const PAGE_SIZE_HINT      = Number(process.env.FA_PAGE_SIZE_HINT || 50); // if <50, likely last page

/* ---------------- utils ---------------- */
const num  = (v,d=0)=>{ const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (v,d=false)=>{ if(v==null||v==='') return !!d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes'; };
function safeParse(t){ try{ return JSON.parse(t||'{}'); } catch { return {}; } }

function normalizePlayers(payload){
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.data))    return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload))          return payload;
  return [];
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sanitizeFaPathCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    if (isSelfFaCandidate(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (!out.length) out.push('/api/free-agents');
  return out;
}

function isSelfFaCandidate(value) {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, PAGES_ORIGIN);
    const pathname = normalizeRelativeFaPath(parsed.pathname);
    const origin = parsed.origin;
    if (PAGES_ORIGIN_ORIGIN && origin === PAGES_ORIGIN_ORIGIN && pathname.toLowerCase() === SELF_PATH_NORMALIZED.toLowerCase()) {
      return true;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const rel = normalizeRelativeFaPath(trimmed);
      if (rel && rel.toLowerCase() === SELF_PATH_NORMALIZED.toLowerCase()) return true;
    }
  } catch {
    const rel = normalizeRelativeFaPath(trimmed);
    if (rel && rel.toLowerCase() === SELF_PATH_NORMALIZED.toLowerCase()) return true;
  }
  return false;
}

function normalizeRelativeFaPath(path) {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const base = trimmed.split('?')[0].split('#')[0];
  if (!base) return '/';
  const withSlash = base.startsWith('/') ? base : `/${base}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

let fetchModulePromise = null;
async function getFetch() {
  if (typeof global.fetch === 'function') return global.fetch.bind(global);
  if (!fetchModulePromise) {
    fetchModulePromise = import('node-fetch').then(mod => mod.default);
  }
  return fetchModulePromise;
}

async function espnGET(url, cand) {
  const fetch = await getFetch();
  const headers = {
    accept: 'application/json',
    'user-agent': 'ff-platform-service/1.0',
    'x-fantasy-platform': 'web',
    'x-fantasy-source': 'kona'
  };
  const cookie = cand?.s2 && cand?.swid ? `espn_s2=${cand.s2}; SWID=${cand.swid};` : '';
  const resp = await fetch(url, cookie ? { headers: { ...headers, cookie } } : { headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, json, text };
}

function parseNumericId(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const match = trimmed.match(/\d{2,}/g);
    if (match && match.length) {
      const last = Number(match[match.length - 1]);
      if (Number.isFinite(last)) return last;
    }
  }
  return null;
}

function extractPlayerId(player) {
  if (!player || typeof player !== 'object') return null;
  const candidates = [
    player.playerId,
    player.id,
    player.player_id,
    player.athleteId,
    player.athlete_id,
    player.athlete?.id,
    player.player?.id,
    player.player?.playerId,
    player.player?.athleteId,
    player.playerPoolEntry?.id,
    player.playerPoolEntry?.player?.id,
    player.playerPoolEntry?.player?.playerId,
    player.playerPoolEntry?.player?.athleteId,
    player.player?.player?.id,
    player.uid,
    player.playerUid,
    player.player?.uid
  ];
  for (const cand of candidates) {
    const parsed = parseNumericId(cand);
    if (parsed != null) return parsed;
  }
  return null;
}

function keyForPlayer(player) {
  if (!player || typeof player !== 'object') return null;
  const name = (player.fullName || player.name || '').toString().trim().toUpperCase();
  const pos = (player.position || player.pos || '').toString().trim().toUpperCase();
  const team = (
    player.teamAbbr ||
    player.proTeamAbbr ||
    player.proTeam ||
    player.team
  );
  const teamStr = team == null ? '' : team.toString().trim().toUpperCase();
  const key = [name, pos, teamStr].filter(Boolean).join('|');
  if (key) return key;
  return null;
}

function filterPlayersNotOwned(players, rosteredIdsInput) {
  const rosteredIds = rosteredIdsInput instanceof Set
    ? rosteredIdsInput
    : new Set(Array.isArray(rosteredIdsInput) ? rosteredIdsInput : []);
  const list = Array.isArray(players) ? players : [];
  const seenKeys = new Set();
  const out = [];
  let filteredCount = 0;
  let duplicateCount = 0;

  for (const player of list) {
    if (!player || typeof player !== 'object') {
      continue;
    }
    const id = extractPlayerId(player);
    if (id != null) {
      if (player.playerId == null) player.playerId = id;
      if (player.id == null) player.id = id;
      if (rosteredIds.has(id)) {
        filteredCount++;
        continue;
      }
    }
    const key = id != null ? `id:${id}` : keyForPlayer(player) || null;
    if (key && seenKeys.has(key)) {
      duplicateCount++;
      continue;
    }
    if (key) seenKeys.add(key);
    out.push(player);
  }

  return {
    players: out,
    filteredCount,
    duplicateCount,
    totalCount: list.length
  };
}

async function loadRosteredPlayerIds({ req, season, leagueId, teamId, memberId, week, credCandidates }) {
  const empty = { ids: new Set(), ok: false, reason: null };
  if (!Number.isFinite(season) || !leagueId) return { ...empty, reason: 'invalid_params' };
  try {
    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams();
    if (Number.isFinite(week) && week > 0) {
      params.set('scoringPeriodId', String(week));
      params.set('matchupPeriodId', String(week));
    }
    params.append('view', 'mTeam');
    params.append('view', 'mRoster');
    const url = `${base}?${params.toString()}`;

    const cands = (Array.isArray(credCandidates) && credCandidates.length)
      ? credCandidates
      : await resolveEspnCredCandidates({
          req,
          season,
          leagueId,
          teamId: Number.isFinite(teamId) ? teamId : null,
          memberId
        });

    let data = null;
    let last = null;

    if (Array.isArray(cands) && cands.length) {
      for (const cand of cands) {
        const res = await espnGET(url, cand);
        last = res;
        if (res.ok && res.json) {
          data = res.json;
          break;
        }
        if (res.status !== 401) break;
      }
    }

    if (!data) {
      const resPub = await espnGET(url, null);
      last = resPub;
      if (resPub.ok && resPub.json) data = resPub.json;
    }

    if (!data) {
      if (last?.status && last.status !== 404) {
        console.warn('[free-agents] failed to load rostered ids', last.status);
      }
      return { ...empty, reason: last?.status ? `status_${last.status}` : 'no_data' };
    }

    const owned = new Set();
    const teams = Array.isArray(data?.teams) ? data.teams : [];
    for (const team of teams) {
      const entries = Array.isArray(team?.roster?.entries) ? team.roster.entries : [];
      for (const entry of entries) {
        const player = entry?.playerPoolEntry?.player || entry.player || {};
        const idCandidates = [
          entry?.playerId,
          entry?.player?.id,
          entry?.playerPoolEntry?.id,
          entry?.playerPoolEntry?.player?.id,
          entry?.playerPoolEntry?.player?.athleteId,
          player?.id,
          player?.playerId,
          player?.athleteId
        ];
        for (const cand of idCandidates) {
          const parsed = parseNumericId(cand);
          if (parsed != null) {
            owned.add(parsed);
            break;
          }
        }
      }
    }
    return { ids: owned, ok: true, reason: null };
  } catch (e) {
    console.warn('[free-agents] ownership lookup failed', e?.message || e);
    return { ...empty, reason: e?.message || 'exception' };
  }
}

function prepareFreeAgentResult(result, rosteredIds) {
  const original = Array.isArray(result?.players) ? result.players : [];
  const filtered = filterPlayersNotOwned(original, rosteredIds);
  let players = filtered.players;
  let filterFallback = false;
  if (filtered.totalCount > 0 && players.length === 0 && original.length) {
    players = original;
    filterFallback = true;
  }
  const filterApplied = !filterFallback && filtered.totalCount > players.length;
  return {
    ...result,
    players,
    filteredCount: filterApplied ? filtered.filteredCount : 0,
    duplicateCount: filterApplied ? filtered.duplicateCount : 0,
    totalCount: filtered.totalCount,
    filterApplied,
    filterFallback
  };
}

function buildFAUrl(basePath, { season, leagueId, week, pos, minProj, onlyEligible, page }){
  const u = new URL(basePath, PAGES_ORIGIN);
  // Some workers use DEF instead of DST
  const workerPos = String(pos || 'ALL').toUpperCase() === 'DST' ? 'DEF' : String(pos || 'ALL').toUpperCase();
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  u.searchParams.set('pos', workerPos);
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  if (page != null) u.searchParams.set('page', String(page));
  return u.toString();
}

function cookieHeaderForCandidate(cand, requestCookie) {
  const parts = [];
  if (cand?.s2) parts.push(`espn_s2=${cand.s2}`);
  if (cand?.swid) parts.push(`SWID=${cand.swid}`);
  if (requestCookie) parts.push(requestCookie);
  return parts.filter(Boolean).join('; ');
}

async function fetchJSONWithTimeoutAndCookies(url, req, ms, cand){
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try{
    const headers = {
      accept: 'application/json',
      'user-agent': req.headers['user-agent'] || 'ff-proxy',
      'x-forwarded-for': req.headers['x-forwarded-for'] || ''
    };
    const cookie = cookieHeaderForCandidate(cand, req.headers.cookie || '');
    if (cookie) headers.cookie = cookie;

    const r = await fetch(url, { headers, signal: ac.signal });
    const txt  = await r.text();
    const json = safeParse(txt);
    const arr  = normalizePlayers(json);
    return { ok: r.ok, status:r.status, url, json, players:arr };
  } catch (e){
    return { ok:false, status:0, url, json:{}, players:[], error:String(e?.name||e||'error') };
  } finally {
    clearTimeout(t);
  }
}

/* ------------- core: try paths; sweep pages; fallback ------------- */
async function pullFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req, credCandidates = []) {
  const tried = [];
  const candidateList = [];

  if (Array.isArray(credCandidates)) {
    for (const cand of credCandidates) {
      if (!cand) continue;
      if (cand.swid || cand.s2) candidateList.push(cand);
    }
  }

  let publicAttemptAdded = false;
  if (!candidateList.length) {
    candidateList.push(null);
    publicAttemptAdded = true;
  }
  if (!publicAttemptAdded) candidateList.push(null); // always try public/request cookie last

  for (const candidate of candidateList) {
    for (const path of FA_PATH_CANDIDATES){
      if (!path) continue;
      let combined = [];

      for (let page = 0; page < MAX_PAGES_PER_CALL; page++){
        const url = buildFAUrl(path, { season, leagueId, week, pos, minProj, onlyEligible, page });
        tried.push(url);

        const res = await fetchJSONWithTimeoutAndCookies(url, req, PER_REQ_TIMEOUT_MS, candidate);
        const batch = Array.isArray(res.players) ? res.players : [];

        // Page 0 empty — abandon this path fast (usually means cred/session missing for that path)
        if (page === 0 && batch.length === 0) { combined = []; break; }

        combined.push(...batch);

        // Early stop: short/empty page suggests end of results
        if (batch.length === 0 || (PAGE_SIZE_HINT && batch.length < PAGE_SIZE_HINT)) break;
      }

      if (combined.length) {
        return { players: combined, upstream: path, tried, usedCandidate: candidate };
      }
    }
  }
  return { players: [], upstream: null, tried, usedCandidate: null };
}

/* ---------------- route ---------------- */
router.get('/free-agents', async (req, res) => {
  try{
    const season       = num(req.query.season);
    const leagueId     = String(req.query.leagueId || '');
    const week         = num(req.query.week, 1);
    const pos          = String(req.query.pos || 'ALL').toUpperCase();
    const minProj      = num(req.query.minProj, 0);          // default 0 (don't over-filter)
    const onlyEligible = bool(req.query.onlyEligible, true); // default true
    const debug        = bool(req.query.debug, false);
    const teamId       = req.query.teamId != null && req.query.teamId !== '' ? Number(req.query.teamId) : null;
    const memberId     = req.query.memberId != null && req.query.memberId !== '' ? String(req.query.memberId) : undefined;

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const normalizedTeamId = Number.isFinite(teamId) ? teamId : null;
    let credCandidates = [];
    try {
      credCandidates = await resolveEspnCredCandidates({
        req,
        season,
        leagueId,
        teamId: normalizedTeamId,
        memberId
      });
    } catch (err) {
      console.warn('[free-agents] cred resolution failed', err?.message || err);
      credCandidates = [];
    }

    const rosterLookup = await loadRosteredPlayerIds({
      req,
      season,
      leagueId,
      teamId: normalizedTeamId,
      memberId,
      week,
      credCandidates
    });
    const rosteredIds = rosterLookup.ids;

    const primaryRaw = await pullFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req, credCandidates);
    const primaryOut = prepareFreeAgentResult(primaryRaw, rosteredIds);
    let out = primaryOut;
    const primaryTried = Array.isArray(primaryRaw?.tried) ? primaryRaw.tried : [];

    let fallbackTried = [];
    if (out.players.length === 0) {
      const relaxedRaw = await pullFreeAgents({ season, leagueId, week, pos, minProj:0, onlyEligible:false }, req, credCandidates);
      fallbackTried = Array.isArray(relaxedRaw?.tried) ? relaxedRaw.tried : [];
      const relaxedOut = prepareFreeAgentResult(relaxedRaw, rosteredIds);
      if (relaxedOut.players.length) {
        out = relaxedOut;
      }
    }

    let directTried = [];
    let directUsed = false;
    let directError = null;
    if (
      out.players.length === 0 &&
      typeof pullFreeAgentsDirectFn === 'function' &&
      typeof normEspnPlayerFn === 'function'
    ) {
      try {
        const directRes = await pullFreeAgentsDirectFn({ season, leagueId, week, pos, teamId: normalizedTeamId, memberId }, req);
        directTried = Array.isArray(directRes?.tried) ? directRes.tried : [];
        const rows = Array.isArray(directRes?.rows) ? directRes.rows : [];
        if (rows.length) {
          let directPlayers = rows.map(p => {
            const mapped = normEspnPlayerFn(p, week);
            if (mapped && typeof mapped === 'object') {
              if (mapped.pos && !mapped.position) mapped.position = mapped.pos;
              if (mapped.team && !mapped.teamAbbr) mapped.teamAbbr = mapped.team;
              if (mapped.team && !mapped.proTeamAbbr) mapped.proTeamAbbr = mapped.team;
              if (mapped.id != null && mapped.playerId == null) mapped.playerId = mapped.id;
            }
            return mapped;
          });
          if (typeof vWeekFn === 'function') {
            directPlayers.forEach(p => { if (p && typeof p === 'object') p._val = vWeekFn(p); });
            directPlayers.sort((a, b) => (Number(b?._val) || 0) - (Number(a?._val) || 0));
          }
          const directOut = prepareFreeAgentResult({
            players: directPlayers,
            upstream: 'espn-direct',
            tried: directTried,
            usedCandidate: directRes?.used || null
          }, rosteredIds);
          if (Array.isArray(directOut.players) && directOut.players.length) {
            directOut.upstream = 'espn-direct';
            directUsed = true;
            out = directOut;
          }
        }
      } catch (err) {
        directError = String(err?.message || err);
      }
    }

    if (Array.isArray(out.players)) {
      for (const pl of out.players) {
        if (pl && typeof pl === 'object' && Object.prototype.hasOwnProperty.call(pl, '_val')) {
          delete pl._val;
        }
      }
    }

    const playersList = Array.isArray(out.players) ? out.players : [];
    const payload = {
      ok: true,
      season,
      leagueId,
      week,
      pos,
      count: playersList.length,
      players: playersList
    };

    if (debug) {
      payload._ff_debug = {
        tried_primary: primaryTried,
        tried_fallback: fallbackTried,
        tried_direct: directTried,
        upstream_path: out.upstream,
        filter_applied: out.filterApplied,
        filter_fallback: out.filterFallback,
        filtered: {
          before: out.totalCount ?? 0,
          removed_rostered: out.filteredCount ?? 0,
          removed_duplicates: out.duplicateCount ?? 0,
          rostered_id_count: rosteredIds.size
        },
        roster_lookup: {
          ok: rosterLookup.ok,
          reason: rosterLookup.reason
        },
        direct: {
          used: directUsed,
          error: directError
        }
      };
    }

    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    const combinedTried = [...primaryTried, ...fallbackTried, ...directTried];
    res.set('X-FF-FA-Tried', combinedTried.join(' | '));
    res.set('X-FF-FA-Upstream', out.upstream || primaryRaw.upstream || 'none');
    res.set('X-FF-FA-Filtered', String(out.filteredCount ?? 0));
    res.set('X-FF-FA-Total', String(out.totalCount ?? playersList.length));
    res.set('X-FF-FA-Rostered', String(rosteredIds.size));
    res.set('X-FF-FA-RosterLookup', rosterLookup.ok ? 'ok' : (rosterLookup.reason || 'fail'));
    res.set('X-FF-FA-FilterFallback', out.filterFallback ? '1' : '0');
    res.set('X-FF-FA-Fallback', directUsed ? 'espn-direct' : (out.filterFallback ? 'filter' : 'none'));
    if (directError) res.set('X-FF-FA-DirectError', directError);
    res.set('X-FF-FA-Source', directUsed ? 'espn-direct:x-fantasy-filter' : 'worker');
    const usedCandidate = out.usedCandidate || null;
    try {
      res.set('x-espn-cred-source', usedCandidate?.source || 'public');
      res.set('x-espn-cred-stale', usedCandidate?.stale ? '1' : '0');
      if (usedCandidate?.swid) {
        const maskedSwid = `${String(usedCandidate.swid).slice(0, 12)}...`;
        res.set('x-ff-cred-swid', maskedSwid);
      }
    } catch {}

    return res.json(payload);
  } catch (e){
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;

