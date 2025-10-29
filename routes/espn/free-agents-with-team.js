// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';
const FUNCTION_ROSTER_PATH      = process.env.FUNCTION_ROSTER_PATH      || '/api/platforms/espn/roster';

/* --------------------------- URL builders --------------------------- */
function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible, page }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  // Worker quirk: some use DEF instead of DST
  const workerPos = String(pos || 'ALL').toUpperCase() === 'DST' ? 'DEF' : String(pos || 'ALL').toUpperCase();
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  u.searchParams.set('pos', workerPos); // ALL/QB/RB/WR/TE/DST/K (DEF upstream)
  u.searchParams.set('minProj', String(minProj ?? 0));
  u.searchParams.set('onlyEligible', String(onlyEligible ?? true));
  if (page != null) u.searchParams.set('page', String(page));
  return u;
}
function buildRosterUrl({ season, leagueId, week }) {
  const u = new URL(FUNCTION_ROSTER_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  if (week != null) u.searchParams.set('week', String(week));
  return u;
}
async function fetchJsonWithCred(url, req, ctx) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url.toString(), req, ctx);
  let data = null;
  try { data = (status >= 200 && status < 300) && body ? JSON.parse(body) : null; } catch { data = null; }
  return { data, status, used, rawBody: body };
}

/* ---------------- Canonical helpers ------------------- */
function toCanonical({
  id, name, position, proTeamId, teamAbbr,
  proj, rank, opponentAbbr, defensiveRank, byeWeek, fmv,
  team
}) {
  return {
    id: Number(id),
    name: name ?? null,
    position: position ?? null,
    proTeamId: (proTeamId == null || isNaN(+proTeamId)) ? null : Number(proTeamId),
    teamAbbr: teamAbbr ?? null,
    proj: (proj == null || isNaN(+proj)) ? null : Number(proj),
    rank: (rank == null || isNaN(+rank)) ? null : Number(rank),
    opponentAbbr: opponentAbbr ?? null,
    defensiveRank: (defensiveRank == null || isNaN(+defensiveRank)) ? null : Number(defensiveRank),
    byeWeek: (byeWeek == null || isNaN(+byeWeek)) ? null : Number(byeWeek),
    fmv: (fmv == null || isNaN(+fmv)) ? null : Number(fmv),
    team: team && team.type ? team : { type: 'FREE_AGENT' }
  };
}
function pidOf(p) {
  for (const k of ['playerId','id','pid','espnId']) {
    const n = Number(p?.[k]); if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}
function normalizeFA(row, teamMeta) {
  const id = Number(row.playerId ?? row.id ?? pidOf(row));
  const position = String(row.position || row.defaultPosition || row.pos || '').toUpperCase();
  return toCanonical({
    id,
    name: row.name,
    position,
    proTeamId: row.proTeamId ?? null,
    teamAbbr: row.teamAbbr ?? row.proTeamAbbr ?? row.team ?? null,
    proj: row.proj ?? row.projectedPoints ?? row.projApplied ?? null,
    rank: row.rank ?? row.projRank ?? null,
    opponentAbbr: row.opponentAbbr ?? row.oppAbbr ?? null,
    defensiveRank: row.defensiveRank ?? null,
    byeWeek: row.byeWeek ?? row.bye ?? null,
    fmv: row.fmv ?? null,
    team: teamMeta || { type: 'FREE_AGENT' }
  });
}
function normalizeRoster(row, teamMeta) {
  const id = Number(row.playerId ?? row.id ?? pidOf(row));
  const position = String(row.position || row.defaultPosition || row.pos || '').toUpperCase();
  return toCanonical({
    id,
    name: row.name,
    position,
    proTeamId: row.proTeamId ?? null,
    teamAbbr: row.teamAbbr ?? row.proTeamAbbr ?? row.team ?? null,
    proj: row.proj ?? null,
    rank: row.rank ?? null,
    opponentAbbr: row.opponentAbbr ?? null,
    defensiveRank: row.defensiveRank ?? null,
    byeWeek: row.byeWeek ?? row.bye ?? null,
    fmv: row.fmv ?? null,
    team: teamMeta || { type: 'TEAM', teamId: null, team_name: null }
  });
}
function enrichRosterWithFA(rosterCan, faCan) {
  if (!faCan) return rosterCan;
  return toCanonical({
    id: rosterCan.id,
    name: rosterCan.name ?? faCan.name,
    position: rosterCan.position ?? faCan.position,
    proTeamId: rosterCan.proTeamId ?? faCan.proTeamId,
    teamAbbr: rosterCan.teamAbbr ?? faCan.teamAbbr,
    proj: faCan.proj,
    rank: faCan.rank,
    opponentAbbr: faCan.opponentAbbr,
    defensiveRank: faCan.defensiveRank,
    byeWeek: rosterCan.byeWeek ?? faCan.byeWeek,
    fmv: faCan.fmv,
    team: rosterCan.team
  });
}

/* ---------------- small utils ---------------- */
const boolParam = (v,d=false)=>{ if(v==null||v==='')return !!d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='y'||s==='yes'; };
const numParam  = (v,d=0)=>{ const n=Number(v); return Number.isFinite(n)?n:d; };

/* ----------------------------- Route ----------------------------- */
// GET /api/platforms/espn/free-agents-with-team?season=YYYY&leagueId=...&week=#&pos=ALL&includeRostered=false
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season        = numParam(req.query.season);
    const leagueId      = String(req.query.leagueId || '');
    const week          = numParam(req.query.week, 1);
    const posInput      = String(req.query.pos || 'ALL').toUpperCase();
    const minProj       = numParam(req.query.minProj, 0);
    const onlyEligible  = boolParam(req.query.onlyEligible, true);
    const includeRostered = boolParam(req.query.includeRostered, false); // <- default FA-only

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    /* 1) Pull FAs FIRST (page by pos), tolerant to shape differences */
    const POS_LIST = (posInput === 'ALL') ? ['QB','RB','WR','TE','DST','K'] : [posInput];
    const players = [];
    const projById = new Map();  // id -> canonical FA row (with projections)
    const MAX_PAGES_PER_POS = 20;

    for (const pos of POS_LIST) {
      for (let page = 0; page < MAX_PAGES_PER_POS; page++) {
        const faUrl = buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible, page });
        const { data: faData } = await fetchJsonWithCred(faUrl, req, { leagueId });

        const batch = Array.isArray(faData?.players) ? faData.players
                    : Array.isArray(faData?.data)    ? faData.data
                    : Array.isArray(faData?.results) ? faData.results
                    : Array.isArray(faData)          ? faData
                    : [];

        if (!batch.length) break;

        for (const raw of batch) {
          const pid = Number(raw.playerId ?? raw.id ?? pidOf(raw));
          if (!Number.isFinite(pid)) continue;
          const canFA = normalizeFA(raw, { type:'FREE_AGENT' });
          projById.set(pid, canFA);
          players.push(canFA);
        }

        // if worker pages are < 50 this is probably the last page
        if (batch.length < 50) break;
      }
    }

    /* If we want pure FAs (default), we're done. */
    if (!includeRostered) {
      res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Cache-Control', 'no-store, private');
      return res.json({
        ok: true,
        season,
        leagueId,
        week,
        pos: posInput,
        count: players.length,
        players
      });
    }

    /* 2) (Optional) Append rostered players not present in FA list */
    const rosterUrl = buildRosterUrl({ season, leagueId, week });
    const { data: rosterData } = await fetchJsonWithCred(rosterUrl, req, { leagueId });

    const rosterCanonById = new Map();
    const playerToTeam = new Map();

    if (rosterData?.teams?.length) {
      for (const t of rosterData.teams) {
        const teamMeta = { type:'TEAM', teamId: t.teamId, team_name: t.team_name };
        for (const p of (t.players || [])) {
          const pid = Number(p.playerId ?? p.id ?? pidOf(p));
          if (!Number.isFinite(pid)) continue;
          playerToTeam.set(pid, teamMeta);
          rosterCanonById.set(pid, normalizeRoster(p, teamMeta));
        }
      }
    } else if (Number.isFinite(rosterData?.teamId)) {
      const teamMeta = { type:'TEAM', teamId: rosterData.teamId, team_name: rosterData.team_name };
      for (const p of (rosterData.players || [])) {
        const pid = Number(p.playerId ?? p.id ?? pidOf(p));
        if (!Number.isFinite(pid)) continue;
        playerToTeam.set(pid, teamMeta);
        rosterCanonById.set(pid, normalizeRoster(p, teamMeta));
      }
    }

    const seen = new Set(players.map(p => p.id));
    const rosterTeams = rosterData?.teams || (rosterData?.players ? [{
      players: rosterData.players, teamId: rosterData.teamId, team_name: rosterData.team_name
    }] : []);

    for (const t of rosterTeams) {
      for (const rp of (t.players || [])) {
        const pid = Number(rp.playerId ?? rp.id ?? pidOf(rp));
        if (!Number.isFinite(pid) || seen.has(pid)) continue;

        // Optional position narrowing
        if (posInput !== 'ALL') {
          const rpPos = String(rp.position || rp.defaultPosition || rp.pos || '').toUpperCase();
          if (rpPos && rpPos !== posInput) continue;
        }

        const teamMeta = { type:'TEAM', teamId: t.teamId, team_name: t.team_name };
        const rosterCan = normalizeRoster(rp, teamMeta);
        const faCan = projById.get(pid) || rosterCanonById.get(pid);
        players.push(enrichRosterWithFA(rosterCan, faCan));
        seen.add(pid);
      }
    }

    /* 3) Respond (FA + rostered, only if requested) */
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');
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
