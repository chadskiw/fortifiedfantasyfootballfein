// routes/espn/free-agents-with-team.js
// Node 18+ for global fetch.
const express = require('express');
const router  = express.Router();

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';

// Candidate FA worker paths (first that returns rows wins)
const FA_PATH_CANDIDATES = (
  process.env.FUNCTION_FREE_AGENTS_PATHS ||
  `${process.env.FUNCTION_FREE_AGENTS_PATH || ''},/api/platforms/espn/free-agents,/api/free-agents`
).split(',').map(s => s.trim()).filter(Boolean);

// Your internal JSON routes (same origin) — only used if includeRostered=true or paintOwnership
const LOCAL_ROSTER_PATH     = '/api/platforms/espn/roster';
const LOCAL_SCOREBOARD_PATH = '/api/platforms/espn/scoreboard';
const LOCAL_MATCHUPS_PATH   = '/api/platforms/espn/matchups';

// Tunables
const PER_REQ_TIMEOUT_MS  = Number(process.env.FA_PER_REQ_TIMEOUT_MS || 1500);
const MAX_PAGES_PER_CALL  = Number(process.env.FA_MAX_PAGES || 8);   // stop when a page is empty/short
const PAGE_SIZE_HINT      = Number(process.env.FA_PAGE_SIZE_HINT || 50);

// ---------- utils ----------
const num  = (v,d=0)=>{ const n=Number(v); return Number.isFinite(n)?n:d; };
const bool = (v,d=false)=>{ if(v==null||v==='')return !!d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes'; };
const safeParse = t => { try{ return JSON.parse(t||'{}'); } catch { return {}; } };

function normalizePlayers(payload){
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.data))    return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload))          return payload;
  return [];
}
function pidOf(p){
  for (const k of ['playerId','id','pid','espnId']) {
    const n = Number(p?.[k]); if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}
function normalizeFA(p){
  const id = pidOf(p);
  const teamAbbr = p.teamAbbr || p.team || '';
  const pos = String(p.position || p.defaultPosition || p.pos || '').toUpperCase();
  const proj = [p.proj, p.projectedPoints, p.projApplied, p.fpProj].map(Number).find(Number.isFinite);
  const applied = Number(p.appliedPoints);
  const pts = Number(p.points);
  const headshot = p.headshot || (id && id > 0
    ? `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`
    : (teamAbbr ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(teamAbbr).toLowerCase()}.png&h=80&w=80&scale=crop` : '')
  );
  return {
    id,
    name: p.name ?? null,
    pos,
    team: teamAbbr || null,
    headshot,
    proj: Number.isFinite(proj) ? proj : null,
    appliedPoints: Number.isFinite(applied) ? applied : null,
    points: Number.isFinite(pts) ? pts : null
  };
}
function vWeek(p){
  const ap = Number(p.appliedPoints); if (Number.isFinite(ap)) return ap;
  const pt = Number(p.points);        if (Number.isFinite(pt)) return pt;
  const pr = Number(p.proj);          return Number.isFinite(pr) ? pr : 0;
}

// ---------- URL builders ----------
function buildFAUrl(basePath, { season, leagueId, week, pos, minProj, onlyEligible, page, dropPos }) {
  const u = new URL(basePath, PAGES_ORIGIN);
  // Some workers expect DEF instead of DST
  const workerPos = String(pos || 'ALL').toUpperCase() === 'DST' ? 'DEF' : String(pos || 'ALL').toUpperCase();
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  if (!(dropPos && workerPos === 'ALL')) u.searchParams.set('pos', workerPos);
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  if (page != null) u.searchParams.set('page', String(page));
  return u.toString();
}
function buildLocalUrl(path, params) {
  const u = new URL(path, PAGES_ORIGIN);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

// ---------- fetchers ----------
async function fetchJSONWithTimeoutAndCookies(url, req, ms){
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try{
    const r   = await fetch(url, {
      headers: {
        accept: 'application/json',
        cookie: req.headers.cookie || '',                // << forward session so worker can resolve member -> SWID/S2
        'user-agent': req.headers['user-agent'] || 'ff-proxy',
        'x-forwarded-for': req.headers['x-forwarded-for'] || '',
        origin: req.headers.origin || PAGES_ORIGIN       // some CF setups read Origin for session scoping
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

async function fetchLocalJSON(url, req){
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      cookie: req.headers.cookie || '',
      'user-agent': req.headers['user-agent'] || 'ff-proxy',
      'x-forwarded-for': req.headers['x-forwarded-for'] || ''
    }
  });
  const txt  = await r.text();
  return safeParse(txt);
}

// Pull FAs from worker (cookies forwarded). Try: strict (pos), strict-no-pos (ALL), relaxed, relaxed-no-pos.
async function pullFreeAgentsViaWorker({ season, leagueId, week, pos, minProj, onlyEligible }, req){
  const tried = [];
  for (const path of FA_PATH_CANDIDATES) {
    if (!path) continue;

    // sweep pages for each variant, stop when a page is empty/short
    const variants = [
      { dropPos:false, minProj, onlyEligible },
      ...(String(pos).toUpperCase()==='ALL' ? [{ dropPos:true, minProj, onlyEligible }] : []),
      { dropPos:false, minProj:0, onlyEligible:false },
      ...(String(pos).toUpperCase()==='ALL' ? [{ dropPos:true, minProj:0, onlyEligible:false }] : [])
    ];

    for (const v of variants){
      let combined = [];
      for (let page=0; page<MAX_PAGES_PER_CALL; page++){
        const url = buildFAUrl(path, { season, leagueId, week, pos, page, ...v });
        tried.push(url);
        const res = await fetchJSONWithTimeoutAndCookies(url, req, PER_REQ_TIMEOUT_MS);
        const batch = Array.isArray(res.players) ? res.players : [];

        if (page === 0 && batch.length === 0) { combined=[]; break; } // try next variant/path
        combined.push(...batch);
        if (batch.length === 0 || (PAGE_SIZE_HINT && batch.length < PAGE_SIZE_HINT)) break;
      }
      if (combined.length) {
        return { players: combined.map(normalizeFA), tried, upstream: path };
      }
    }
  }
  return { players: [], tried, upstream: null };
}

// Ownership helpers (optional)
function idsFromRosterJSON(json){
  const ids = new Set();
  if (Array.isArray(json?.teams)) {
    for (const t of json.teams) for (const p of (t.players||[])) {
      const id = pidOf(p); if (Number.isFinite(id)) ids.add(id);
    }
  } else if (Array.isArray(json?.players)) {
    for (const p of json.players) { const id = pidOf(p); if (Number.isFinite(id)) ids.add(id); }
  }
  return ids;
}
async function myAndOppIds({ season, leagueId, week, teamId }, req){
  const myUrl  = buildLocalUrl(LOCAL_ROSTER_PATH, { season, leagueId, week, teamId });
  const myJson = await fetchLocalJSON(myUrl, req);
  const myIds  = idsFromRosterJSON(myJson);
  // Try to infer opponent
  const schedUrl = buildLocalUrl(LOCAL_SCOREBOARD_PATH, { season, leagueId, week });
  const mUrl     = buildLocalUrl(LOCAL_MATCHUPS_PATH,   { season, leagueId, week });
  const sb = await fetchLocalJSON(schedUrl, req);
  const mu = await fetchLocalJSON(mUrl, req);
  const games = sb.matchups || sb.schedule || sb.games || mu.matchups || mu.schedule || [];
  let oppTeamId = null;
  for (const g of games) {
    const teams = g.teams || [g.home, g.away].filter(Boolean) || (g.matchup?.teams) || [];
    const ids = teams.map(t => Number(t?.teamId ?? t?.team?.id ?? t?.id)).filter(Number.isFinite);
    if (ids.includes(teamId)) { oppTeamId = ids.find(x => x !== teamId) ?? null; break; }
  }
  let oppIds = new Set();
  if (Number.isFinite(oppTeamId)) {
    const oppUrl  = buildLocalUrl(LOCAL_ROSTER_PATH, { season, leagueId, week, teamId: oppTeamId });
    const oppJson = await fetchLocalJSON(oppUrl, req);
    oppIds = idsFromRosterJSON(oppJson);
  }
  return { myIds, oppIds };
}

// ---------- route ----------
router.get('/free-agents-with-team', async (req, res) => {
  try{
    const season          = num(req.query.season);
    const leagueId        = String(req.query.leagueId || '');
    const week            = num(req.query.week, 1);
    const pos             = String(req.query.pos || 'ALL').toUpperCase();
    const minProj         = num(req.query.minProj, 0);
    const onlyEligible    = bool(req.query.onlyEligible, true);
    const includeRostered = bool(req.query.includeRostered, false); // default: pure FAs
    const teamId          = num(req.query.teamId, NaN);             // for ownership paint (optional)

    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    // 1) Pull FAs directly from worker with cookies
    const { players: faRaw, tried, upstream } =
      await pullFreeAgentsViaWorker({ season, leagueId, week, pos, minProj, onlyEligible }, req);

    let players = faRaw.map(p => (p._val = vWeek(p), p)).sort((a,b)=> (b._val||0) - (a._val||0));

    // 2) (Optional) paint ownership + append rostered if asked
    if (Number.isFinite(teamId) || includeRostered) {
      const { myIds, oppIds } = Number.isFinite(teamId)
        ? await myAndOppIds({ season, leagueId, week, teamId }, req)
        : { myIds: new Set(), oppIds: new Set() };

      // mark ownership for FAs we already have
      if (Number.isFinite(teamId)) {
        players.forEach(p => {
          const id = Number(p.id);
          if (myIds.has(id))      p._ownedBy = 'me';
          else if (oppIds.has(id)) p._ownedBy = 'opp';
          else                     p._ownedBy = 'fa';
        });
      }

      if (includeRostered) {
        // append rostered not already in list
        const rosterUrl = buildLocalUrl(LOCAL_ROSTER_PATH, { season, leagueId, week });
        const rosterJson = await fetchLocalJSON(rosterUrl, req);
        const rosterSeen = new Set(players.map(p => Number(p.id)));
        const allTeams = rosterJson?.teams || (rosterJson?.players ? [{
          teamId: rosterJson.teamId, team_name: rosterJson.team_name, players: rosterJson.players
        }] : []);
        for (const t of allTeams) {
          for (const rp of (t.players || [])) {
            const id = pidOf(rp);
            if (!Number.isFinite(id) || rosterSeen.has(id)) continue;
            if (pos !== 'ALL') {
              const rpPos = String(rp.position || rp.defaultPosition || rp.pos || '').toUpperCase();
              if (rpPos && rpPos !== pos) continue;
            }
            const can = normalizeFA(rp);
            can._val = vWeek(can);
            if (Number.isFinite(teamId)) {
              if (myIds.has(id))      can._ownedBy = 'me';
              else if (oppIds.has(id)) can._ownedBy = 'opp';
              else                      can._ownedBy = 'fa';
            }
            players.push(can);
            rosterSeen.add(id);
          }
        }
        players.sort((a,b)=> (b._val||0) - (a._val||0));
      }
    }

    // headers + cors
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Tried', tried.join(' | '));
    res.set('X-FF-FA-Upstream', upstream || 'none');

    return res.json({
      ok: true,
      season, leagueId, week, pos,
      count: players.length,
      players
    });
  } catch (e){
    console.error('[free-agents-with-team] fatal', e);
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
