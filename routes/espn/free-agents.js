// routes/espn/free-agents.js
// Node 18+ for global fetch (AbortController). If older, polyfill as needed.
const express = require('express');
const router  = express.Router();

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
    const minProj      = num(req.query.minProj, 0);          // default 0 (don’t over-filter)
    const onlyEligible = bool(req.query.onlyEligible, true); // default true
    const debug        = bool(req.query.debug, false);

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // First pass: as requested (WITH cookies)
    let out = await pullFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req);

    // Fallback once: relax filters (minProj=0, onlyEligible=false) if empty
    let fallbackTried = [];
    if (out.players.length === 0) {
      const relaxed = await pullFreeAgents({ season, leagueId, week, pos, minProj:0, onlyEligible:false }, req);
      fallbackTried = relaxed.tried;
      if (relaxed.players.length) out = relaxed;
    }

    // Always return a "players" array
    const payload = { ok:true, season, leagueId, week, pos, count: out.players.length, players: out.players };

    if (debug) {
      payload._ff_debug = {
        tried_primary: out.tried,
        tried_fallback: fallbackTried,
        upstream_path: out.upstream
      };
    }

    // CORS + debug headers
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Tried', [...out.tried, ...fallbackTried].join(' | '));
    res.set('X-FF-FA-Upstream', out.upstream || 'none');

    return res.json(payload);
  } catch (e){
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
