// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
// FA worker (adjust if mounted elsewhere)
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';

// Your internal JSON routes (same origin)
const LOCAL_ROSTER_PATH = '/api/platforms/espn/roster';
const LOCAL_SCOREBOARD_PATHS = ['/api/platforms/espn/scoreboard', '/api/platforms/espn/matchups'];

/* -------------------- helpers -------------------- */
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
function vWeek(p) {
  const ap = Number(p.appliedPoints);
  const pt = Number(p.points);
  const pr = Number(p.proj);
  if (Number.isFinite(ap)) return ap;
  if (Number.isFinite(pt)) return pt;
  return Number.isFinite(pr) ? pr : 0;
}
function normalizeFA(p) {
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

/* -------------------- URL builders -------------------- */
function buildFAUrl({ season, leagueId, week, pos, minProj, onlyEligible }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  u.searchParams.set('pos', String(pos || 'ALL'));
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  return u.toString();
}
function buildLocalUrl(path, params) {
  const u = new URL(path, PAGES_ORIGIN);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/* -------------------- fetchers -------------------- */
// Use ESPN creds helper ONLY for worker/ESPN URLs
async function fetchFA(url, req, leagueId) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url, req, { leagueId });
  return { status, json: safeParse(body), used };
}

// Use plain fetch with forwarded cookies for YOUR internal routes
async function fetchLocalJSON(url, req) {
  const r = await fetch(url, {
    headers: {
      cookie: req.headers.cookie || '',
      'user-agent': req.headers['user-agent'] || 'ff-proxy',
      'x-forwarded-for': req.headers['x-forwarded-for'] || '',
      'accept': 'application/json'
    }
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}

/* -------------------- core logic -------------------- */
async function getFreeAgents({ season, leagueId, week, pos, minProj, onlyEligible }, req) {
  const url1 = buildFAUrl({ season, leagueId, week, pos, minProj, onlyEligible });
  const r1 = await fetchFA(url1, req, leagueId);

  let arr = Array.isArray(r1.json?.players) ? r1.json.players
          : Array.isArray(r1.json?.data) ? r1.json.data
          : [];

  let usedFallback = false;
  let url2 = null;

  if (!arr.length) {
    usedFallback = true;
    url2 = buildFAUrl({ season, leagueId, week, pos, minProj: 0, onlyEligible: false });
    const r2 = await fetchFA(url2, req, leagueId);
    arr = Array.isArray(r2.json?.players) ? r2.json.players
        : Array.isArray(r2.json?.data) ? r2.json.data
        : [];
  }

  const players = arr.map(normalizeFA);
  players.forEach(p => { p._val = vWeek(p); });
  players.sort((a,b) => (b._val||0) - (a._val||0));

  return { players, upstream: url1, fallbackUrl: url2, usedFallback };
}

async function getMyAndOppIds({ season, leagueId, week, teamId }, req) {
  if (!Number.isFinite(teamId)) return { my: null, opp: null };

  // my roster (internal route; needs cookies/session)
  const myUrl = buildLocalUrl(LOCAL_ROSTER_PATH, { season, leagueId, week, teamId });
  const myRes = await fetchLocalJSON(myUrl, req);
  const myIds = new Set((myRes.json?.players || []).map(pidOf).filter(Number.isFinite));

  // try to find opponent
  let oppTeamId = null;
  for (const path of LOCAL_SCOREBOARD_PATHS) {
    const sbUrl = buildLocalUrl(path, { season, leagueId, week });
    const sb = await fetchLocalJSON(sbUrl, req);
    const games = sb.json?.matchups || sb.json?.schedule || sb.json?.games || [];
    for (const g of games) {
      const teams = g.teams || [g.home, g.away].filter(Boolean) || (g.matchup?.teams) || [];
      const ids = teams.map(t => Number(t?.teamId ?? t?.team?.id ?? t?.id)).filter(Number.isFinite);
      if (ids.includes(teamId)) { oppTeamId = ids.find(x => x !== teamId) ?? null; break; }
    }
    if (oppTeamId) break;
  }

  let oppIds = null;
  if (Number.isFinite(oppTeamId)) {
    const oppUrl = buildLocalUrl(LOCAL_ROSTER_PATH, { season, leagueId, week, teamId: oppTeamId });
    const oppRes = await fetchLocalJSON(oppUrl, req);
    oppIds = new Set((oppRes.json?.players || []).map(pidOf).filter(Number.isFinite));
  }

  return { my: myIds, opp: oppIds };
}

/* -------------------- route -------------------- */
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season       = numParam(req.query.season);
    const leagueId     = String(req.query.leagueId || '');
    const week         = numParam(req.query.week, 1);
    const posInput     = String(req.query.pos || 'ALL').toUpperCase();
    const minProj      = numParam(req.query.minProj, 0);
    const onlyEligible = boolParam(req.query.onlyEligible, true);
    const teamId       = numParam(req.query.teamId, NaN); // optional for ownership painting

    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    // Fetch FAs from worker (with one relaxed fallback)
    const { players, upstream, fallbackUrl, usedFallback } =
      await getFreeAgents({ season, leagueId, week, pos: posInput, minProj, onlyEligible }, req);

    // Paint ownership if we can (no league-wide sweep)
    if (Number.isFinite(teamId)) {
      const { my, opp } = await getMyAndOppIds({ season, leagueId, week, teamId }, req);
      if (my || opp) {
        players.forEach(p => {
          const id = Number(p.id);
          if (my && my.has(id)) p._ownedBy = 'me';
          else if (opp && opp.has(id)) p._ownedBy = 'opp';
          else p._ownedBy = 'fa';
        });
      }
    }

    // Headers + CORS
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Upstream', upstream);
    if (usedFallback && fallbackUrl) res.set('X-FF-FA-Fallback', fallbackUrl);

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
