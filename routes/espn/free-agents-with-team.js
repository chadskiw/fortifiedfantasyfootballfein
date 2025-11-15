// routes/espn/free-agents-with-team.js
// Pull FREE AGENTS directly from ESPN using X-Fantasy-Filter (no Pages/Worker).
// Requires Node 18+ (global fetch) and your existing fetchFromEspnWithCandidates.
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

/* ---------------- constants ---------------- */
const ESPN_PLAYERS_BASE = (season, leagueId) =>
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/players`;

// SlotId map for ESPN player filters
const SLOT_IDS = {
  QB: [0],
  RB: [2],
  WR: [4],
  TE: [6],
  DST: [16],
  DEF: [16], // alias just in case
  K:  [17],
  ALL: [0,2,4,6,16,17]
};

const POS_FROM_SLOT = { 0:'QB',2:'RB',4:'WR',6:'TE',16:'DST',17:'K',23:'FLEX' };

/* ---------------- utils ---------------- */
const num  = (v,d=0)=>{ const n=Number(v); return Number.isFinite(n)?n:d; };
const bool = (v,d=false)=>{ if(v==null||v==='')return !!d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes'; };
function safeParseArr(txt){ try{ const j=JSON.parse(txt||'[]'); return Array.isArray(j)?j:[]; }catch{return[];} }

function headshotFor(id, teamAbbr){
  if (Number.isFinite(id) && id>0) return `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
  if (teamAbbr) return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(teamAbbr).toLowerCase()}.png&h=80&w=80&scale=crop`;
  return '';
}

function normEspnPlayer(p, week){
  const id        = Number(p.id);
  const name      = p.fullName || [p.firstName,p.lastName].filter(Boolean).join(' ') || null;
  const pos       = POS_FROM_SLOT[Number(p.defaultPositionId)] || null;
  const teamAbbr  = p.proTeamAbbreviation || null;

  // Try to extract this-week proj and actuals (both optional)
  let proj=null, appliedPoints=null;
  // Some leagues expose ratings keyed by scoringPeriodId
  if (p.ratings && p.ratings[String(week)]?.totalRating != null)
    proj = Number(p.ratings[String(week)].totalRating);
  // Stats may include applied actuals
  if (Array.isArray(p.stats)) {
    const s = p.stats.find(s => s.scoringPeriodId===week && s.statSourceId===0);
    if (s && s.appliedTotal != null) appliedPoints = Number(s.appliedTotal);
  }

  return {
    id,
    name,
    pos,
    team: teamAbbr,
    headshot: headshotFor(id, teamAbbr),
    proj: Number.isFinite(proj) ? proj : null,
    appliedPoints: Number.isFinite(appliedPoints) ? appliedPoints : null,
    points: null
  };
}
function vWeek(p){
  const ap=Number(p.appliedPoints); if(Number.isFinite(ap))return ap;
  const pt=Number(p.points);        if(Number.isFinite(pt))return pt;
  const pr=Number(p.proj);          return Number.isFinite(pr)?pr:0;
}

/* ---------------- ESPN fetch (with X-Fantasy-Filter) ---------------- */
async function espnPlayersPage({ season, leagueId, week, slotIds, offset, limit }, req, credCandidate){
  // ESPN requires filters in the X-Fantasy-Filter header (query-string filters are ignored/inconsistent)
  const filter = {
    filterStatus: { value: ['FREEAGENT','WAIVERS'] },
    filterSlotIds: { value: slotIds },
    // Ask ESPN to include ranks/projections for this week if available
    filterRanksForScoringPeriodIds: { value: [week] },
    // Include actuals/projections context; sort by this week total if present
    sortAppliedStatTotal: { sortAsc: false, statSplitTypeId: 0, value: week },
    limit,
    offset
  };

  const url = `${ESPN_PLAYERS_BASE(season, leagueId)}?scoringPeriodId=${week}&view=kona_player_info`;

  const { status, body, used, error } = await fetchFromEspnWithCandidates(url, req, {
    leagueId,
    cand: credCandidate || undefined,
    extraHeaders: {
      // Extra headers ESPN looks for:
      'x-fantasy-filter': JSON.stringify(filter),
      'x-fantasy-platform': 'kona-p',
      accept: 'application/json'
    }
  });

  const arr = safeParseArr(body);
  return { status, arr, url, used, error };
}

/* ---------------- core pull ---------------- */
async function pullFreeAgentsDirect({ season, leagueId, week, pos }, req, credCandidate){
  const slotIds = SLOT_IDS[pos] || SLOT_IDS.ALL;
  const LIMIT   = 50;
  const all     = [];
  const tried   = [];
  const errors  = [];

  for (let offset=0; offset<1000; offset+=LIMIT){
    const { status, arr, url, used, error } = await espnPlayersPage({ season, leagueId, week, slotIds, offset, limit: LIMIT }, req, credCandidate);
    tried.push(url);
    if (error) errors.push(error);
    if (status < 200 || status >= 300) break;
    if (!arr.length) break;
    all.push(...arr);
    if (arr.length < LIMIT) break; // last page
  }
  return { rows: all, tried, errors };
}

/* ---------------- route ---------------- */
router.get('/free-agents-with-team', async (req, res) => {
  try{
    const season   = num(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = num(req.query.week, 1);
    const pos      = String(req.query.pos || 'ALL').toUpperCase();
    // (We ignore onlyEligible/minProj here; ESPN gives true FA/Waivers already.)

    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const { rows, tried } = await pullFreeAgentsDirect({ season, leagueId, week, pos }, req);

    let players = rows.map(p => normEspnPlayer(p, week));
    players.forEach(p => p._val = vWeek(p));
    players.sort((a,b)=> (b._val||0)-(a._val||0));

    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
    res.set('X-FF-FA-Source', 'espn-direct:x-fantasy-filter');
    res.set('X-FF-FA-Tried', tried.join(' | '));

    return res.json({
      ok:true,
      season, leagueId, week, pos,
      count: players.length,
      players
    });
  } catch (e){
    console.error('[free-agents-with-team] espn-direct error', e);
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
module.exports.pullFreeAgentsDirect = pullFreeAgentsDirect;
module.exports.normEspnPlayer = normEspnPlayer;
module.exports.vWeek = vWeek;
