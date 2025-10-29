// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
// Pair this with your free-agents route/worker (set env if mounted elsewhere)
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';
const FUNCTION_ROSTER_PATH      = process.env.FUNCTION_ROSTER_PATH      || '/api/platforms/espn/roster';

/* --------------------------- URL builders --------------------------- */
function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible, page }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  if (pos) u.searchParams.set('pos', String(pos || 'ALL')); // ALL/QB/RB/WR/TE/DST/K
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  if (page != null) u.searchParams.set('page', String(page));
  return u.toString();
}

function buildRosterUrl({ season, leagueId, week, teamId }) {
  const u = new URL(FUNCTION_ROSTER_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  if (week != null) u.searchParams.set('week', String(week));
  if (teamId != null) u.searchParams.set('teamId', String(teamId));
  return u.toString();
}

/* --------------------------- helpers --------------------------- */
function boolParam(v, dft = false) {
  if (v === undefined || v === null || v === '') return !!dft;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}
function numParam(v, dft = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}
function safeParse(body) {
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
function pidOf(p) {
  for (const k of ['playerId','id','pid','espnId']) {
    const n = Number(p?.[k]);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}
function normalizeFA(p) {
  // tolerant normalization across shapes
  const id = pidOf(p);
  const proj = [p.proj, p.projApplied, p.proj_raw, p.fpProj].map(Number).find(Number.isFinite);
  const applied = Number(p.appliedPoints);
  const pts = Number(p.points);
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
    appliedPoints: Number.isFinite(applied) ? applied : null,
    points: Number.isFinite(pts) ? pts : null
  };
}
function vWeek(p) {
  // prefer real scores (applied->points) else projection
  const ap = Number(p.appliedPoints);
  const pt = Number(p.points);
  const pr = Number(p.proj);
  if (Number.isFinite(ap)) return ap;
  if (Number.isFinite(pt)) return pt;
  return Number.isFinite(pr) ? pr : 0;
}

/* --------------------------- core fetchers --------------------------- */
async function fetchJSONViaCred(url, req, leagueId) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url, req, { leagueId });
  return { status, json: safeParse(body), used };
}

async function getFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req) {
  // primary
  const url1 = buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible });
  const r1 = await fetchJSONViaCred(url1, req, leagueId);

  let rawPlayers = Array.isArray(r1.json?.players) ? r1.json.players
                 : Array.isArray(r1.json?.data) ? r1.json.data
                 : [];

  // fallback if empty: relax filters once
  let usedFallback = false;
  if (!rawPlayers.length) {
    usedFallback = true;
    const url2 = buildFreeAgentsUrl({ season, leagueId, week, pos, minProj: 0, onlyEligible: false });
    const r2 = await fetchJSONViaCred(url2, req, leagueId);
    rawPlayers = Array.isArray(r2.json?.players) ? r2.json.players
                 : Array.isArray(r2.json?.data) ? r2.json.data
                 : [];
  }
  return { players: rawPlayers.map(normalizeFA), upstream: url1, usedFallback };
}

async function getLeagueRosteredIds({ season, leagueId, week }, req) {
  // fetch team rosters 1..20; tolerate holes
  const maxTeams = 20;
  const ids = new Set();
  const reqs = [];
  for (let teamId=1; teamId<=maxTeams; teamId++) {
    const url = buildRosterUrl({ season, leagueId, week, teamId });
    reqs.push(fetchJSONViaCred(url, req, leagueId).catch(()=>({status:0,json:{}})));
  }
  const all = await Promise.all(reqs);
  for (const r of all) {
    const arr = Array.isArray(r.json?.players) ? r.json.players : [];
    for (const p of arr) {
      const pid = pidOf(p);
      if (Number.isFinite(pid)) ids.add(pid);
    }
  }
  return ids;
}

/* --------------------------- route --------------------------- */
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season          = numParam(req.query.season);
    const leagueId        = String(req.query.leagueId || '');
    const week            = numParam(req.query.week, 1);
    const posInput        = String(req.query.pos || 'ALL').toUpperCase();
    const minProj         = numParam(req.query.minProj, 0);
    const onlyEligible    = boolParam(req.query.onlyEligible, true);
    const includeRostered = boolParam(req.query.includeRostered, false);
    const paintOwnership  = boolParam(req.query.paintOwnership, true);

    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    // Fetch free agents
    const { players: faPlayers, upstream, usedFallback } =
      await getFreeAgents({ season, leagueId, week, pos: posInput, minProj, onlyEligible }, req);

    // Optionally filter out rostered across the league (true FA-only behavior)
    let players = faPlayers.slice();
    let rosteredAll = null;
    if (!includeRostered) {
      rosteredAll = await getLeagueRosteredIds({ season, leagueId, week }, req);
      players = players.filter(p => !rosteredAll.has(Number(p.id)));
    }

    // Add computed weekly value + sort desc by value for convenience
    players.forEach(p => { p._val = vWeek(p); });
    players.sort((a,b) => (b._val||0) - (a._val||0));

    // paintOwnership=true: mark my/opp ownership if we can (optional)
    let myIds = null, oppIds = null;
    if (paintOwnership) {
      const teamId = numParam(req.query.teamId, null);
      if (Number.isFinite(teamId)) {
        // my roster
        const myRoster = await fetchJSONViaCred(buildRosterUrl({ season, leagueId, week, teamId }), req, leagueId);
        myIds = new Set((myRoster.json?.players||[]).map(pidOf).filter(Number.isFinite));
        // opponent via scoreboard/matchups (best-effort)
        for (const path of ['/api/platforms/espn/scoreboard', '/api/platforms/espn/matchups']) {
          const u = new URL(path, PAGES_ORIGIN);
          u.searchParams.set('season', String(season));
          u.searchParams.set('leagueId', String(leagueId));
          u.searchParams.set('week', String(week));
          const sco = await fetchJSONViaCred(u.toString(), req, leagueId);
          const games = sco.json?.matchups || sco.json?.schedule || sco.json?.games || [];
          let oppTeamId = null;
          for (const g of games) {
            const teams = g.teams || [g.home, g.away].filter(Boolean) || (g.matchup?.teams) || [];
            const ids = teams.map(t => Number(t?.teamId ?? t?.team?.id ?? t?.id)).filter(Number.isFinite);
            if (ids.includes(teamId)) {
              oppTeamId = ids.find(x => x !== teamId) ?? null;
              break;
            }
          }
          if (oppTeamId) {
            const oppRoster = await fetchJSONViaCred(buildRosterUrl({ season, leagueId, week, teamId: oppTeamId }), req, leagueId);
            oppIds = new Set((oppRoster.json?.players||[]).map(pidOf).filter(Number.isFinite));
            break;
          }
        }
        // attach flags
        if (myIds || oppIds) {
          players.forEach(p => {
            const id = Number(p.id);
            if (myIds && myIds.has(id))   p._ownedBy = 'me';
            else if (oppIds && oppIds.has(id)) p._ownedBy = 'opp';
            else p._ownedBy = 'fa';
          });
        }
      }
    }

    // headers for debugging
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Upstream', upstream);
    if (usedFallback) res.set('X-FF-FA-Fallback', '1');

    return res.json({
      ok: true,
      season,
      leagueId,
      week,
      pos: posInput,
      count: players.length,
      players
    });
  } catch (e) {
    console.error('[free-agents-with-team] error', e);
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
