// routes/fp-apply-week.js  (CommonJS)
const express = require('express');
const router  = express.Router();

// Use built-in fetch on Node 18+, else fall back to undici
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try { ({ fetch: fetchFn } = require('undici')); }
  catch (_) { throw new Error('Install undici or run on Node 18+: npm i undici'); }
}
const fetch = (...args) => fetchFn(...args);

const SCORINGS = ['PPR','HALF','STD'];

/* ---------------- helpers ---------------- */

function apiBaseFromReq(req){
  // Prefer explicit internal origin; otherwise the current host
  return process.env.INTERNAL_API_ORIGIN
      || process.env.HOST
      || `${req.protocol}://${req.get('host')}`;
}

async function getAllLeagues(db, season){
  // Prefer registry table
  const rows = await db.any(`
    SELECT DISTINCT league_id
    FROM ff_sport_ffl
    WHERE season = $1
    ORDER BY league_id
  `, [season]);
  if (rows.length) return rows.map(r => String(r.league_id));

  // Fallback to env list (comma-separated)
  const envList = (process.env.FF_LEAGUES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return envList;
}

async function getTeamsForLeague(db, season, leagueId){
  const rows = await db.any(`
    SELECT DISTINCT team_id, MAX(team_name) AS team_name
    FROM ff_sport_ffl
    WHERE season = $1 AND league_id = $2
    GROUP BY team_id
    ORDER BY team_id
  `, [season, leagueId]);
  return rows.map(r => ({ team_id: Number(r.team_id), team_name: r.team_name || '' }));
}

async function fpIdFor(db, espnId){
  const row = await db.oneOrNone(`
    SELECT fp_id
    FROM ff_fp_player_map
    WHERE espn_id = $1 OR espn_player_id = $1
    LIMIT 1
  `, [Number(espnId)]);
  return row?.fp_id || null;
}

async function weeklyPts(db, { season, week, scoring, fpId }){
  if (!fpId) return 0;
  const row = await db.oneOrNone(`
    SELECT points FROM ff_fp_points_week
    WHERE season=$1 AND week=$2 AND scoring=$3 AND fp_id=$4
    LIMIT 1
  `, [season, week, scoring, fpId]);
  return Number(row?.points || 0);
}

function toStarterRow(p){
  return {
    id: Number(p.playerId ?? p.id),
    name: p.name || p.fullName || p.playerName || '',
    slot: p.slot || p.lineupSlot || p.lineupSlotId || '',
    team: p.teamAbbr || p.proTeam || p.team || '',
    position: p.position || p.defaultPosition || '',
    fpId: null,
    pts: 0
  };
}

async function fetchRoster(req, { season, week, leagueId, teamId }){
  const base = apiBaseFromReq(req);
  const url  = `${base}/api/platforms/espn/roster?season=${season}&week=${week}&leagueId=${leagueId}&teamId=${teamId}`;
  const r = await fetch(url, { method:'GET' });
  if (!r.ok) throw new Error(`roster ${leagueId}:${teamId} HTTP ${r.status}`);
  return r.json();
}

async function upsertTeamWeek(db, row){
  await db.none(`
    INSERT INTO ff_team_weekly_points
      (season, league_id, team_id, week, team_name, points, starters, scoring, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
    ON CONFLICT (season, league_id, team_id, week, scoring)
    DO UPDATE SET
      team_name = EXCLUDED.team_name,
      starters  = EXCLUDED.starters,
      points    = EXCLUDED.points,
      updated_at= NOW()
  `, [
    row.season, String(row.league_id), Number(row.team_id), Number(row.week),
    row.team_name || '', Number(row.points || 0),
    JSON.stringify(row.starters || []), String(row.scoring || 'PPR')
  ]);
}

/* ---------------- route ---------------- */

router.post('/apply-week', async (req, res) => {
  const db = req.app.get('db'); // pg-promise/pg pool set elsewhere
  try{
    const season  = Number(req.body?.season) || new Date().getFullYear();
    const week    = Number(req.body?.week);
    if (!Number.isFinite(week) || week < 1 || week > 18) {
      return res.status(400).json({ ok:false, error:'Invalid `week` (1–18).' });
    }
    const scorings = Array.isArray(req.body?.scorings) && req.body.scorings.length
      ? req.body.scorings.map(s => String(s).toUpperCase())
      : SCORINGS;

    const leagues = await getAllLeagues(db, season);
    if (!leagues.length) return res.status(404).json({ ok:false, error:'No leagues for season.' });

    const summary = [];
    for (const leagueId of leagues){
      const teams = await getTeamsForLeague(db, season, leagueId);

      for (const t of teams){
        let roster;
        try {
          roster = await fetchRoster(req, { season, week, leagueId, teamId: t.team_id });
        } catch (e) {
          summary.push({ leagueId, teamId: t.team_id, error: `roster: ${e.message}` });
          continue;
        }

        // starters list (prefer server’s isStarter; fallback by slot whitelist)
        const players = roster.players || roster?.team?.players || roster || [];
        const startersRaw = players.filter(p =>
          p.isStarter ||
          ['QB','RB','WR','TE','FLEX','K','DST'].includes(String(p.slot || '').toUpperCase())
        );

        // normalize + map fpId
        const starters = startersRaw.map(toStarterRow);
        for (const s of starters){ s.fpId = await fpIdFor(db, s.id); }

        // per scoring: compute pts and upsert
        for (const scoring of scorings){
          const rows = [];
          for (const s of starters){
            const pts = await weeklyPts(db, { season, week, scoring, fpId: s.fpId });
            rows.push({ ...s, pts: Number(pts.toFixed(2)) });
          }
          const points = Number(rows.reduce((a,b)=> a + (b.pts || 0), 0).toFixed(2));

          await upsertTeamWeek(db, {
            season, league_id: leagueId, team_id: t.team_id,
            week, scoring, team_name: roster.team_name || t.team_name || '',
            starters: rows, points
          });

          summary.push({ leagueId, teamId: t.team_id, scoring, count: rows.length, points });
        }
      }
    }

    res.json({ ok:true, season, week, scorings, updated: summary.length, summary });
  } catch (err){
    console.error('apply-week error', err);
    res.status(500).json({ ok:false, error: String(err.message || err) });
  }
});

module.exports = router;
