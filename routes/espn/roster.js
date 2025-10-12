 // routes/espn/roster.js
 const express = require('express');
 const router  = express.Router();
 const { resolveEspnCredCandidates } = require('./_cred');
 const { fetchJsonWithCred } = require('./_fetch');

 const NFL_MAX_WEEK = 18;

// If week is provided, clamp it; if not, return null so we can derive current.
function readWeekOrNull(req){
  const w = Number(req.query.week);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  return null;
}

async function resolveCurrentWeek({ season, leagueId, req, debug }) {
  // Look up league status (mSettings) to determine current scoring period
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = `${base}?view=mSettings`;
  const cands = await resolveEspnCredCandidates({ req, leagueId, debug });
  for (const cand of cands.length ? cands : [{}]) {
    const res = await fetchJsonWithCred(url, cand);
    if (res.ok && res.json) {
      const s = res.json?.status || {};
      // Prefer currentScoringPeriodId, fall back to latest
      const wk = Number(s.currentScoringPeriodId || s.latestScoringPeriodId || 1);
      return Math.min(Math.max(1, wk), NFL_MAX_WEEK);
    }
  }
  return 1;
}

 // ... (TEAM_ABBR, POS, SLOT, resolveHeadshot, buildKonaIndex, espnRosterEntryToPlayer unchanged)

 async function getRosterFromUpstream({ season, leagueId, week, teamId, req, debug }) {
   if (!season || !leagueId) throw new Error('season and leagueId are required');

   const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
   const params = new URLSearchParams({
     matchupPeriodId: String(week),
     scoringPeriodId: String(week),
   });
   // IMPORTANT: add kona_player_info so we get projections like FA view
   params.append('view','mTeam');
   params.append('view','mRoster');
   params.append('view','mSettings');
   params.append('view','mBoxscore'); // <— gives projected stats

   const url = `${base}?${params.toString()}`;

   const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, debug });
   let data = null;
   let last = null;

   for (const cand of cands.length ? cands : [{}]) { // allow anonymous
     const res = await fetchJsonWithCred(url, cand);
     if (res.ok && res.json) {
       try { req.res?.set?.('x-espn-cred-source', cand.source || 'anonymous'); } catch {}
       data = res.json;
       break;
     }
     last = res;
   }

   if (!data) {
     const status = last?.status || 500;
     const text   = (last?.text || '').slice(0, 240);
     const err    = status >= 500 ? 'upstream_5xx' : (status === 401 ? 'unauthorized' : 'upstream_error');
     const e = new Error(err);
     e.meta = { status, text, url };
     throw e;
   }

   // Create a fast lookup of projections/stats per player (same week)
   const konaIndex = buildKonaIndex(data, week);

   const teamNameOf = (t) => `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim() || t?.name || `Team ${t?.id}`;

   if (teamId != null) {
     const team = (data?.teams || []).find(t => Number(t?.id) === Number(teamId));
     return {
       ok:true,
       team_name: team ? teamNameOf(team) : `Team ${teamId}`,
       players: team?.roster?.entries || [],
       konaIndex
     };
   }

   return {
     ok: true,
     konaIndex,
     teams: (data?.teams || []).map(t => ({
       teamId: t?.id,
       team_name: teamNameOf(t),
       players: t?.roster?.entries || []
     }))
   };
 }

 // quick mount test
 router.get('/roster/selftest', (_req, res) => res.json({ ok:true, msg:'roster router mounted' }));

 router.get('/roster', async (req, res) => {
   try {
     const season   = Number(req.query.season);
     const leagueId = String(req.query.leagueId || '');
     const teamId   = req.query.teamId != null ? Number(req.query.teamId) : null;
    // If week not provided → derive from league status (current scoring period)
    let week = readWeekOrNull(req);
    if (!Number.isFinite(week)) {
      week = await resolveCurrentWeek({ season, leagueId, req });
+    }

     const raw = await getRosterFromUpstream({ season, leagueId, week, teamId, req });

     if (teamId != null) {
       const players = (raw.players || []).map(entry => {
         const pid = Number(entry?.player?.id || entry?.playerId || entry?.playerPoolEntry?.player?.id);
         const extras = raw.konaIndex.get(pid) || {};
         return espnRosterEntryToPlayer(entry, extras);
         });
       return res.json({ ok:true, platform:'espn', leagueId, season, week, teamId, team_name: raw.team_name, players });
     }

     const teams = (raw.teams || []).map(t => ({
       teamId: t.teamId,
       team_name: t.team_name,
       players: (t.players || []).map(entry => {
         const pid = Number(entry?.player?.id || entry?.playerId || entry?.playerPoolEntry?.player?.id);
         const extras = raw.konaIndex.get(pid) || {};
         return espnRosterEntryToPlayer(entry, extras);
       }),
     }));
     res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
   } catch (err) {
     const status = err?.meta?.status >= 500 ? 502 : 500;
     res.status(status).json({
       ok: false,
       error: err.message || 'server_error',
       status: err?.meta?.status || status,
       detail: err?.meta?.text || undefined
     });
   }
 });
