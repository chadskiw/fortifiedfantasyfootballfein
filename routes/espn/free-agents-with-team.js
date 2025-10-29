// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();

// ===== Config =====
// If your Pages/Worker lives elsewhere, set PAGES_ORIGIN_FA to that host.
const PAGES_ORIGIN_FA = process.env.PAGES_ORIGIN_FA || process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';

// Try these worker paths in order until one returns players.
const FA_PATH_CANDIDATES = (
  process.env.FUNCTION_FREE_AGENTS_PATHS ||
  '/api/platforms/espn/free-agents,/api/free-agents'
).split(',').map(s => s.trim()).filter(Boolean);

// ===== Utils =====
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function bool(v, d=false){
  if (v === undefined || v === null || v === '') return !!d;
  const s = String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes';
}
function safeParse(t){ try { return JSON.parse(t||'{}'); } catch { return {}; } }
function vWeek(p){
  const ap = Number(p.appliedPoints); if (Number.isFinite(ap)) return ap;
  const pt = Number(p.points);        if (Number.isFinite(pt)) return pt;
  const pr = Number(p.proj);          return Number.isFinite(pr) ? pr : 0;
}
function pidOf(p){
  for (const k of ['playerId','id','pid','espnId']) {
    const n = Number(p?.[k]); if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}
function normalizeFA(p){
  const id = pidOf(p);
  const proj = [p.proj, p.projApplied, p.proj_raw, p.fpProj].map(Number).find(Number.isFinite);
  const teamAbbr = p.teamAbbr || p.team || '';
  const pos = String(p.position || p.pos || '').toUpperCase();
  const headshot = p.headshot || (id && id > 0
    ? `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`
    : (teamAbbr ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(teamAbbr).toLowerCase()}.png&h=80&w=80&scale=crop` : '')
  );
  return {
    id,
    name: p.name,
    pos,
    team: teamAbbr,
    headshot,
    proj: Number.isFinite(proj) ? proj : null,
    appliedPoints: Number.isFinite(+p.appliedPoints) ? +p.appliedPoints : null,
    points: Number.isFinite(+p.points) ? +p.points : null
  };
}

// Build a worker URL. If pos==='ALL', we try once WITH pos and once WITHOUT pos.
function buildFAUrl(basePath, { season, leagueId, week, pos, minProj, onlyEligible, dropPos }) {
  const u = new URL(basePath, PAGES_ORIGIN_FA);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  if (!(dropPos && String(pos).toUpperCase()==='ALL')) {
    u.searchParams.set('pos', String(pos || 'ALL'));
  }
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  return u.toString();
}

async function fetchFAOnce(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  const txt = await r.text();
  const json = safeParse(txt);
  const arr = Array.isArray(json?.players) ? json.players
           : Array.isArray(json?.data)    ? json.data
           : [];
  return { status: r.status, url, players: arr, raw: json };
}

/**
 * Try multiple FA endpoints + filter relaxations:
 *   1) strict    (minProj keep; onlyEligible=true; pos as given)
 *   2) strict-no-pos (if pos==='ALL')
 *   3) relaxed  (minProj=0; onlyEligible=false; pos as given)
 *   4) relaxed-no-pos (if pos==='ALL')
 */
async function getFreeAgentsRobust({ season, leagueId, week, pos, minProj, onlyEligible }) {
  const tried = [];
  for (const path of FA_PATH_CANDIDATES) {
    // 1) strict
    let url = buildFAUrl(path, { season, leagueId, week, pos, minProj, onlyEligible, dropPos:false });
    tried.push(url);
    let r = await fetchFAOnce(url);
    if (r.players.length) return { players: r.players.map(normalizeFA), tried };

    // 2) strict-no-pos (ALL only)
    if (String(pos).toUpperCase() === 'ALL') {
      url = buildFAUrl(path, { season, leagueId, week, pos, minProj, onlyEligible, dropPos:true });
      tried.push(url);
      r = await fetchFAOnce(url);
      if (r.players.length) return { players: r.players.map(normalizeFA), tried };
    }

    // 3) relaxed
    url = buildFAUrl(path, { season, leagueId, week, pos, minProj:0, onlyEligible:false, dropPos:false });
    tried.push(url);
    r = await fetchFAOnce(url);
    if (r.players.length) return { players: r.players.map(normalizeFA), tried };

    // 4) relaxed-no-pos (ALL only)
    if (String(pos).toUpperCase() === 'ALL') {
      url = buildFAUrl(path, { season, leagueId, week, pos, minProj:0, onlyEligible:false, dropPos:true });
      tried.push(url);
      r = await fetchFAOnce(url);
      if (r.players.length) return { players: r.players.map(normalizeFA), tried };
    }
  }
  return { players: [], tried };
}

// ===== Route =====
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season   = num(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = num(req.query.week, 1);
    const pos      = String(req.query.pos || 'ALL').toUpperCase();
    const minProj  = num(req.query.minProj, 0);
    const onlyElig = bool(req.query.onlyEligible, true);
    // NOTE: we are NOT touching roster here to avoid any other failures

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const { players, tried } = await getFreeAgentsRobust({ season, leagueId, week, pos, minProj, onlyEligible });

    // headers / CORS
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Tried', tried.join(' | '));
    res.set('X-FF-FA-Found', String(players.length));

    // Always return a players array (even if empty) so clients don't explode
    return res.json({
      ok: true,
      season, leagueId, week, pos,
      count: players.length,
      players
    });
  } catch (e) {
    console.error('[free-agents-with-team] fatal', e);
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
