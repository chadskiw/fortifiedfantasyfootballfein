// routes/espn/free-agents.js
// Node 18+ for global fetch (AbortController). If older, polyfill as needed.
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';

// Try these FA worker paths in order (configurable)
const FA_PATH_CANDIDATES = (
  process.env.FUNCTION_FREE_AGENTS_PATHS ||
  `${process.env.FUNCTION_FREE_AGENTS_PATH || ''},/api/platforms/espn/free-agents,/api/free-agents`
).split(',').map(s => s.trim()).filter(Boolean);

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

async function loadRosteredPlayerIds({ req, season, leagueId, teamId, memberId, week }) {
  if (!Number.isFinite(season) || !leagueId) return new Set();
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

    const cands = await resolveEspnCredCandidates({
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
      return new Set();
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
    return owned;
  } catch (e) {
    console.warn('[free-agents] ownership lookup failed', e?.message || e);
    return new Set();
  }
}

function prepareFreeAgentResult(result, rosteredIds) {
  const filtered = filterPlayersNotOwned(result?.players, rosteredIds);
  return {
    ...result,
    players: filtered.players,
    filteredCount: filtered.filteredCount,
    duplicateCount: filtered.duplicateCount,
    totalCount: filtered.totalCount
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

async function fetchJSONWithTimeoutAndCookies(url, req, ms){
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try{
    const r   = await fetch(url, {
      headers: {
        accept: 'application/json',
        cookie: req.headers.cookie || '',                // <-- forward session
        'user-agent': req.headers['user-agent'] || 'ff-proxy',
        'x-forwarded-for': req.headers['x-forwarded-for'] || ''
      },
      signal: ac.signal
    });
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
async function pullFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req) {
  const tried = [];
  for (const path of FA_PATH_CANDIDATES){
    if (!path) continue;
    let combined = [];

    for (let page = 0; page < MAX_PAGES_PER_CALL; page++){
      const url = buildFAUrl(path, { season, leagueId, week, pos, minProj, onlyEligible, page });
      tried.push(url);

      const res = await fetchJSONWithTimeoutAndCookies(url, req, PER_REQ_TIMEOUT_MS);
      const batch = Array.isArray(res.players) ? res.players : [];

      // Page 0 empty → abandon this path fast (usually means cred/session missing for that path)
      if (page === 0 && batch.length === 0) { combined = []; break; }

      combined.push(...batch);

      // Early stop: short/empty page suggests end of results
      if (batch.length === 0 || (PAGE_SIZE_HINT && batch.length < PAGE_SIZE_HINT)) break;
    }

    if (combined.length) {
      return { players: combined, upstream: path, tried };
    }
  }
  return { players: [], upstream: null, tried };
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

    const rosteredIds = await loadRosteredPlayerIds({ req, season, leagueId, teamId, memberId, week });

    const primaryRaw = await pullFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req);
    const primaryOut = prepareFreeAgentResult(primaryRaw, rosteredIds);
    let out = primaryOut;
    const primaryTried = Array.isArray(primaryRaw?.tried) ? primaryRaw.tried : [];

    let fallbackTried = [];
    if (out.players.length === 0) {
      const relaxedRaw = await pullFreeAgents({ season, leagueId, week, pos, minProj:0, onlyEligible:false }, req);
      fallbackTried = Array.isArray(relaxedRaw?.tried) ? relaxedRaw.tried : [];
      const relaxedOut = prepareFreeAgentResult(relaxedRaw, rosteredIds);
      if (relaxedOut.players.length) {
        out = relaxedOut;
      }
    }

    const payload = {
      ok: true,
      season,
      leagueId,
      week,
      pos,
      count: out.players.length,
      players: out.players
    };

    if (debug) {
      payload._ff_debug = {
        tried_primary: primaryTried,
        tried_fallback: fallbackTried,
        upstream_path: out.upstream,
        filtered: {
          before: out.totalCount ?? 0,
          removed_rostered: out.filteredCount ?? 0,
          removed_duplicates: out.duplicateCount ?? 0,
          rostered_id_count: rosteredIds.size
        }
      };
    }

    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Tried', [...primaryTried, ...fallbackTried].join(' | '));
    res.set('X-FF-FA-Upstream', out.upstream || primaryRaw.upstream || 'none');
    res.set('X-FF-FA-Filtered', String(out.filteredCount ?? 0));
    res.set('X-FF-FA-Total', String(out.totalCount ?? out.players.length));
    res.set('X-FF-FA-Rostered', String(rosteredIds.size));

    return res.json(payload);
  } catch (e){
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
