// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

// Keep these in sync with your existing free-agents route/env
const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';
const FUNCTION_ROSTER_PATH      = process.env.FUNCTION_ROSTER_PATH      || '/api/platforms/espn/roster';

// Builders to hit your CF functions (mirrors your existing route style)
function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible, page }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week',   String(week));
  u.searchParams.set('pos',    String(pos || 'ALL')); // ALL/QB/RB/WR/TE/DST/K
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

// Helper: fetch JSON via your credential-rotating fetcher
async function fetchJsonWithCred(url, req, ctx) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url.toString(), req, ctx);
  const data = (status >= 200 && status < 300) && body ? JSON.parse(body) : null;
  return { data, status, used, rawBody: body };
}

// Normalize a FA/roster row to a common shape we return downstream
function normalizePlayerRow(raw, teamMetaFromMap) {
  // Allow either FA payload ('playerId') or roster payload ('playerId'|'id')
  const id = Number(raw.playerId ?? raw.id);
  const teamAbbr = raw.teamAbbr || raw.proTeamAbbr || raw.proTeam || null;

  // Projection-ish fields (FA payload usually has these)
  const proj = (raw.proj != null) ? Number(raw.proj) : (raw.projectedPoints != null ? Number(raw.projectedPoints) : null);
  const fmv  = (raw.fmv  != null) ? Number(raw.fmv)  : null;
  const rank = (raw.rank != null) ? Number(raw.rank) : (raw.projRank != null ? Number(raw.projRank) : null);
  const byeWeek = raw.byeWeek != null ? Number(raw.byeWeek) : (raw.bye != null ? Number(raw.bye) : null);

  const pos = String(raw.position || raw.defaultPosition || raw.pos || '').toUpperCase().replace('DST', 'DST');
  const opp = raw.opponentAbbr || raw.oppAbbr || null;

  // Team ownership meta is provided externally for FA rows; for roster rows we inject it
  const team = raw.team && raw.team.type ? raw.team : (teamMetaFromMap || { type: 'FREE_AGENT' });

  return {
    id,
    name: raw.name,
    position: pos,
    teamAbbr: teamAbbr,
    opponentAbbr: opp,
    defensiveRank: raw.defensiveRank ?? null,
    byeWeek,
    proj,
    fmv,
    rank,
    // pass the raw too if the client wants extra columns someday
    team
  };
}

// GET /api/platforms/espn/free-agents-with-team?season=2025&leagueId=...&week=1
// Optional: pos=ALL|QB|RB|WR|TE|DST|K (default ALL), minProj, onlyEligible=true|false
// Optional: teamIds=1,4 (limit roster merge to these teamIds)
router.get('/free-agents-with-team', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const week     = Number(req.query.week || 1);

    const posInput     = String(req.query.pos || 'ALL').toUpperCase();
    const minProj      = Number(req.query.minProj ?? 0);
    const onlyEligible = String(req.query.onlyEligible ?? 'true') === 'true';

    // Optional: restrict roster merge to specific teams
    const teamIdsFilter = (req.query.teamIds || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(n => Number(n))
      .filter(n => Number.isFinite(n));

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // -------- 1) Fetch league rosters (all teams by default) --------
    const rosterUrl = buildRosterUrl({ season, leagueId, week });
    const { data: rosterData, used: rosterUsed } =
      await fetchJsonWithCred(rosterUrl, req, { leagueId });

    // Build playerId -> TEAM meta from roster
    const playerToTeam = new Map();
    if (rosterData?.teams?.length) {
      for (const t of rosterData.teams) {
        if (teamIdsFilter.length && !teamIdsFilter.includes(Number(t.teamId))) continue;
        const teamMeta = { type:'TEAM', teamId: t.teamId, team_name: t.team_name };
        for (const p of (t.players || [])) {
          const pid = Number(p.playerId || p.id);
          if (Number.isFinite(pid)) playerToTeam.set(pid, teamMeta);
        }
      }
    } else if (Number.isFinite(rosterData?.teamId)) {
      // single-team payload shape
      const teamMeta = { type:'TEAM', teamId: rosterData.teamId, team_name: rosterData.team_name };
      for (const p of (rosterData.players || [])) {
        const pid = Number(p.playerId || p.id);
        if (Number.isFinite(pid)) playerToTeam.set(pid, teamMeta);
      }
    }

    // -------- 2) Pull FA pages PER POSITION and build a projection map --------
    const POS_LIST = (posInput === 'ALL')
      ? ['QB','RB','WR','TE','DST','K']
      : [posInput];

    const players = [];
    const projById = new Map();  // id -> normalized FA row (with proj/rank/etc.)
    const MAX_PAGES_PER_POS = 20;

    for (const pos of POS_LIST) {
      for (let page = 0; page < MAX_PAGES_PER_POS; page++) {
        const faUrl = buildFreeAgentsUrl({
          season, leagueId, week, pos, minProj, onlyEligible, page
        });
        const { data: faData, used: faUsed } =
          await fetchJsonWithCred(faUrl, req, { leagueId });

        // mirror credential headers for debugging
        if (faUsed) {
          res.set('X-ESPN-Cred-Source', faUsed.source || '');
          res.set('X-ESPN-Cred-SWID',   faUsed.swidMasked || '');
          res.set('X-ESPN-Cred-S2',     faUsed.s2Masked || '');
        }
        if (rosterUsed) {
          res.set('X-ESPN-Cred-Source-Roster', rosterUsed.source || '');
        }

        const batch = Array.isArray(faData?.players) ? faData.players : [];
        if (!batch.length) break;

        for (const p of batch) {
          const pid = Number(p.playerId || p.id);
          if (!Number.isFinite(pid)) continue;

          // Keep a normalized FA version with projections in a map for enrichment
          const normFA = normalizePlayerRow(p, /* teamMetaFromMap */ null);
          projById.set(pid, normFA);

          // If this player is actually rostered in THIS league, mark it so;
          // otherwise keep as FA.
          const teamMeta = playerToTeam.get(pid) || { type:'FREE_AGENT' };
          const merged = { ...normFA, team: teamMeta };
          players.push(merged);
        }

        // heuristic: free-agents worker tends to deliver 50/page; break if shorter
        if (batch.length < 50) break;
      }
    }

    // -------- 3) Add rostered players not present in FA pages, ENRICH with projections --------
    const INCLUDE_ROSTERED = true;
    if (INCLUDE_ROSTERED && playerToTeam.size) {
      const seen = new Set(players.map(p => Number(p.id)));
      const rosterTeams = rosterData?.teams || (rosterData?.players ? [{
        players: rosterData.players, teamId: rosterData.teamId, team_name: rosterData.team_name
      }] : []);

      for (const t of rosterTeams) {
        if (teamIdsFilter.length && !teamIdsFilter.includes(Number(t.teamId))) continue;

        for (const rp of (t.players || [])) {
          const pid = Number(rp.playerId || rp.id);
          if (!Number.isFinite(pid) || seen.has(pid)) continue;

          // Normalize roster row (no projections yet)
          const base = normalizePlayerRow(rp, { type:'TEAM', teamId: t.teamId, team_name: t.team_name });

          // Enrich from FA projection map if available
          const fa = projById.get(pid);
          const enriched = fa
            ? {
                ...fa,
                // ensure ownership points to TEAM (not FA)
                team: { type:'TEAM', teamId: t.teamId, team_name: t.team_name }
              }
            : base; // fallback: leave proj/rank null if we don’t have them

          players.push(enriched);
          seen.add(pid);
        }
      }
    }

    // -------- 4) Respond --------
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
