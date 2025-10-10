// routes/espn/free-agents-with-team.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

// Keep these in sync with your existing free-agents route/env
const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';
const FUNCTION_ROSTER_PATH = process.env.FUNCTION_ROSTER_PATH || '/api/platforms/espn/roster';

// Builders to hit your CF functions (mirrors your existing route style)
function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible, page }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week',   String(week));
  u.searchParams.set('pos',    String(pos || 'ALL'));    // expects worker to accept ALL/QB/RB/WR/TE/DST/K
  u.searchParams.set('minProj', String(minProj ?? 0));
  u.searchParams.set('onlyEligible', String(onlyEligible ?? true));
  if (page != null) u.searchParams.set('page', String(page)); // worker should accept this; we’ll loop pages
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

// GET /api/free-agents-with-team?season=2025&leagueId=...&week=1
// Optional: pos=ALL|QB|RB|WR|TE|DST|K (default ALL), minProj, onlyEligible=true|false
// Optional: teamIds=1,4 (if you want to include only these teams’ rosters in the merged set)
// Response: { ok:true, season, leagueId, week, players:[{..., team:{...}}] }
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

    if (!rosterData || !rosterData.ok) {
      // Still proceed; we can mark only free agents if roster fetch fails
    }

    // Build playerId -> team mapping
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

    // -------- 2) Fetch free agents, paging by pos + page --------
    const POS_LIST = (posInput === 'ALL')
      ? ['QB','RB','WR','TE','DST','K']
      : [posInput];

    const players = [];
    const MAX_PAGES_PER_POS = 20; // safety
    for (const pos of POS_LIST) {
      for (let page = 0; page < MAX_PAGES_PER_POS; page++) {
        const faUrl = buildFreeAgentsUrl({
          season, leagueId, week, pos, minProj, onlyEligible, page
        });
        const { data: faData, used: faUsed } =
          await fetchJsonWithCred(faUrl, req, { leagueId });

        // Mirror credential headers for debugging
        if (faUsed) {
          res.set('X-ESPN-Cred-Source', faUsed.source || '');
          res.set('X-ESPN-Cred-SWID',   faUsed.swidMasked || '');
          res.set('X-ESPN-Cred-S2',     faUsed.s2Masked || '');
        }
        if (rosterUsed) {
          res.set('X-ESPN-Cred-Source-Roster', rosterUsed.source || '');
        }

        // If worker returns shape { ok:true, players:[...] }
        const batch = Array.isArray(faData?.players) ? faData.players : [];
        if (!batch.length) break; // done with this pos

        for (const p of batch) {
          const pid = Number(p.playerId || p.id);
          const teamMeta = playerToTeam.get(pid) || { type:'FREE_AGENT' };
          players.push({ ...p, team: teamMeta });
        }

        // If worker returns a known page size (<= 0 means last)
        if (batch.length < 50) break; // heuristic: stop early if we didn’t fill a typical page
      }
    }

    // -------- 3) Optionally add rostered players that match filters but weren’t in FA --------
    // If you want rostered players included regardless of projections (to mirror “ALL”),
    // flip this to true.
    const INCLUDE_ROSTERED = true;
    if (INCLUDE_ROSTERED && playerToTeam.size) {
      // Build a quick set of ids we already added (from FA loop)
      const seen = new Set(players.map(p => Number(p.playerId || p.id)));
      // Flatten roster players, apply lightweight filter by pos if present
      const rosterTeams = rosterData?.teams || (rosterData?.players ? [{ players: rosterData.players, teamId: rosterData.teamId, team_name: rosterData.team_name }] : []);
      for (const t of rosterTeams) {
        if (teamIdsFilter.length && !teamIdsFilter.includes(Number(t.teamId))) continue;
        for (const rp of (t.players || [])) {
          const pid = Number(rp.playerId || rp.id);
          if (!Number.isFinite(pid) || seen.has(pid)) continue;

          // If a pos filter was set (not ALL), skip mismatches when possible
          if (posInput !== 'ALL') {
            const rpPos = String(rp.pos || rp.defaultPosition || rp.position || '').toUpperCase();
            if (rpPos && rpPos !== posInput) continue;
          }

          players.push({
            ...rp,
            team: { type:'TEAM', teamId: t.teamId, team_name: t.team_name }
          });
          seen.add(pid);
        }
      }
    }

    // -------- 4) CORS/Cache & respond --------
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
