// routes/espn/free-agents-with-team.js
// Direct-to-ESPN FA pull (no worker). Node 18+ for global fetch/URL.
// Uses fetchFromEspnWithCandidates to attach SWID/S2 for the given league.
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';

// --- ESPN constants ---
const ESPN_PLAYERS_BASE = (season, leagueId) =>
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/players`;

const SLOT_IDS = {
  QB: [0],
  RB: [2],
  WR: [4],
  TE: [6],
  DST:[16], // D/ST
  DEF:[16], // alias
  K:  [17],
  ALL:[0,2,4,6,16,17]
};

const POS_FROM_SLOT = {
  0:'QB', 2:'RB', 3:'RB/WR', 4:'WR', 5:'WR/TE', 6:'TE',
  16:'DST', 17:'K', 23:'FLEX'
};

// --- utils ---
const num  = (v,d=0)=>{ const n=Number(v); return Number.isFinite(n)?n:d; };
const bool = (v,d=false)=>{ if(v==null||v==='') return !!d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes'; };
const enc  = obj => encodeURIComponent(JSON.stringify(obj));
function safeParseJSON(text){ try { return JSON.parse(text||'[]'); } catch { return []; } }

function headshotForId(id, teamAbbr){
  if (Number.isFinite(id) && id > 0)
    return `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
  if (teamAbbr)
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(teamAbbr).toLowerCase()}.png&h=80&w=80&scale=crop`;
  return '';
}

function normalizeEspnPlayer(p, week) {
  // ESPN player object fields are fairly stable in v3
  const id        = Number(p.id);
  const name      = p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || null;
  const posId     = Number(p.defaultPositionId);
  const pos       = POS_FROM_SLOT[posId] || (p.defaultPosition && String(p.defaultPosition).toUpperCase()) || null;
  const proTeamId = Number(p.proTeamId);
  const teamAbbr  = p.proTeamAbbreviation || null;

  // projections (best-effort): ratingsForSplit and ratingsByStat might vary across leagues
  let proj = null, points = null, appliedPoints = null;
  // Try to pluck the week's projected total if available
  const ratings = p.ratings || p.ratingsForSplit || {};
  const wkKey   = String(week);
  if (ratings[wkKey]?.totalRating != null) proj = Number(ratings[wkKey].totalRating);
  else if (ratings['0']?.totalRating != null) proj = Number(ratings['0'].totalRating);

  // Realized points (appliedPoints) show up only after games lock/finalize; ESPN often exposes in stats/pointsByScoringPeriod
  if (p.stats && p.stats.length) {
    const sThis = p.stats.find(s => s.scoringPeriodId === week && s.statSourceId === 0 /*actual*/);
    if (sThis && sThis.appliedTotal != null) appliedPoints = Number(sThis.appliedTotal);
  }

  return {
    id,
    name,
    pos,
    team: teamAbbr,
    headshot: headshotForId(id, teamAbbr),
    proj: Number.isFinite(proj) ? proj : null,
    appliedPoints: Number.isFinite(appliedPoints) ? appliedPoints : null,
    points: Number.isFinite(points) ? points : null
  };
}

function vWeek(p){
  const ap = Number(p.appliedPoints); if (Number.isFinite(ap)) return ap;
  const pt = Number(p.points);        if (Number.isFinite(pt)) return pt;
  const pr = Number(p.proj);          return Number.isFinite(pr) ? pr : 0;
}

// --- ESPN fetch via fetchFromEspnWithCandidates (attaches SWID/S2 automatically) ---
async function espnFetchJSON(url, req, ctx) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url, req, ctx);
  // ESPN returns array for /players endpoint
  const json = safeParseJSON(body);
  return { status, json, used };
}

/**
 * Pull free agents & waivers directly from ESPN (no worker).
 * - filters by slotIds derived from pos
 * - scoringPeriodId=week
 * - status FREEAGENT + WAIVERS
 * - pages until empty/short
 */
async function pullEspnFreeAgents({ season, leagueId, week, pos }) {
  const slotIds = SLOT_IDS[pos] || SLOT_IDS.ALL;
  const base    = ESPN_PLAYERS_BASE(season, leagueId);
  const tried   = [];
  const all     = [];
  const LIMIT   = 50;

  for (let offset = 0; offset < 1000; offset += LIMIT) {
    const params = [
      `scoringPeriodId=${week}`,
      `view=kona_player_info`,
      `limit=${LIMIT}`,
      `offset=${offset}`,
      // Only FAs/waivers
      `filterStatus=${enc({ value: ['FREEAGENT','WAIVERS'] })}`,
      // Position filter
      `filterSlotIds=${enc({ value: slotIds })}`,
      // Ask ESPN to include rankings for this week (helps proj in some leagues)
      `filterRanksForScoringPeriodIds=${enc({ value: [week] })}`
    ].join('&');

    const url = `${base}?${params}`;
    tried.push(url);

    const { status, json } = await espnFetchJSON(url, /*req*/ pullEspnFreeAgents.__req, { leagueId });
    if (status < 200 || status >= 300) break;

    if (!Array.isArray(json) || json.length === 0) break;
    all.push(...json);
    if (json.length < LIMIT) break; // last page
  }

  return { tried, rows: all };
}

// To pass req through to espnFetchJSON without threading every function signature
pullEspnFreeAgents.__req = null;

/* ================= Route ================= */
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season       = num(req.query.season);
    const leagueId     = String(req.query.leagueId || '');
    const week         = num(req.query.week, 1);
    const posInput     = String(req.query.pos || 'ALL').toUpperCase();
    const includeRostered = bool(req.query.includeRostered, false); // default FA-only
    // Note: onlyEligible/minProj are ignored for ESPN direct; slot filter covers eligibility

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // 1) Direct ESPN pull (no worker). Attach req for SWID/S2 helper.
    pullEspnFreeAgents.__req = req;
    const { tried, rows } = await pullEspnFreeAgents({ season, leagueId, week, pos: posInput });

    // 2) Normalize
    let players = rows.map(p => normalizeEspnPlayer(p, week));
    if (!includeRostered) {
      // ESPN already filtered to FREEAGENT/WAIVERS; nothing else needed
    }
    // sort by best "this week" value (actuals > proj)
    players.forEach(p => p._val = vWeek(p));
    players.sort((a,b)=> (b._val||0) - (a._val||0));

    // 3) Respond
    res.set('Access-Control-Allow-Origin', req.headers.origin || PAGES_ORIGIN);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Source', 'espn-direct');
    res.set('X-FF-FA-Tried', tried.join(' | '));
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
    console.error('[free-agents-with-team] espn-direct error', e);
    res.set('Access-Control-Allow-Origin', req.headers.origin || PAGES_ORIGIN);
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
