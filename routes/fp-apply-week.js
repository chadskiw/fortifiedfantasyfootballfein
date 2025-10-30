// routes/fp-apply-week.js  (CommonJS)
const express = require('express');
const router  = express.Router();
router.use(express.json()); // ensure JSON body parsing

/* ---------------- DB bootstrap (local fallback) ---------------- */
const { Pool } = require('pg');
const localPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

/** Wrap a db so it exposes pg-promise-like methods: any / oneOrNone / none */
function wrapDb(raw){
  if (!raw) return null;
  if (typeof raw.any === 'function' && typeof raw.oneOrNone === 'function' && typeof raw.none === 'function'){
    return raw; // pg-promise
  }
  if (typeof raw.query === 'function'){ // node-postgres Pool/Client
    return {
      any      : (q, p = []) => raw.query(q, p).then(r => r.rows),
      oneOrNone: (q, p = []) => raw.query(q, p).then(r => r.rows[0] || null),
      none     : (q, p = []) => raw.query(q, p).then(() => undefined),
    };
  }
  return null;
}
function getDb(req){
  const candidate =
    (req.app && typeof req.app.get === 'function' && req.app.get('db')) ||
    (req.app && req.app.locals && req.app.locals.db) ||
    null;
  let shared = null;
  try { shared = require('../db/pool'); } catch (_) {}
  return wrapDb(candidate) || wrapDb(shared) || wrapDb(localPool);
}

/* ---------------- fetch (Node 18+ or undici) ---------------- */
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try { ({ fetch: fetchFn } = require('undici')); }
  catch (_) { throw new Error('Install undici or run on Node 18+: npm i undici'); }
}
const fetch = (...args) => fetchFn(...args);

/* ---------------- helpers ---------------- */
function apiBaseFromReq(req){
  return process.env.INTERNAL_API_ORIGIN
      || process.env.HOST
      || `${req.protocol}://${req.get('host')}`;
}

async function getAllLeagues(db, season){
  const rows = await db.any(`
    SELECT DISTINCT league_id
    FROM ff_sport_ffl
    WHERE season = $1
    ORDER BY league_id
  `, [season]);
  if (rows.length) return rows.map(r => String(r.league_id));

  const envList = (process.env.FF_LEAGUES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return envList;
}

async function getTeamsForLeague(db, season, leagueId, rosterFetch){
  const rows = await db.any(`
    SELECT DISTINCT team_id, MAX(team_name) AS team_name
    FROM ff_sport_ffl
    WHERE season = $1 AND league_id = $2
    GROUP BY team_id
    ORDER BY team_id
  `, [season, leagueId]);
  if (rows.length) return rows.map(r => ({ team_id: Number(r.team_id), team_name: r.team_name || '' }));

  // Fallback discover by probing roster endpoint
  const MAX_TEAMS = 20;
  const out = [];
  for (let tid=1; tid<=MAX_TEAMS; tid++){
    try{
      const ro = await rosterFetch({ teamId: tid });
      if (ro?.team_name) out.push({ team_id: tid, team_name: ro.team_name });
    }catch(_){}
  }
  return out;
}

async function detectScoringLabel(req, season, leagueId){
  try{
    const base = apiBaseFromReq(req);
    const r = await fetch(`${base}/api/platforms/espn/league?season=${season}&leagueId=${leagueId}`, { method:'GET' });
    if (!r.ok) return 'LEAGUE';
    const j = await r.json();
    // Try common shapes: look for points per reception
    const rec = j?.settings?.scoringSettings?.reception ??
                j?.settings?.scoring?.reception ??
                j?.scoringSettings?.reception ??
                j?.scoring?.reception ??
                null;
    if (rec === 1) return 'PPR';
    if (rec === 0.5) return 'HALF';
    if (rec === 0) return 'STD';
    return 'LEAGUE';
  }catch(_){
    return 'LEAGUE';
  }
}

function toStarterRow(p){
  return {
    id      : Number(p.playerId ?? p.id),
    name    : p.name || p.fullName || p.playerName || '',
    slot    : p.slot || p.lineupSlot || p.lineupSlotId || '',
    team    : p.teamAbbr || p.proTeam || p.team || '',
    position: p.position || p.defaultPosition || '',
    pts     : 0
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
    JSON.stringify(row.starters || []), String(row.scoring || 'LEAGUE')
  ]);
}

/* ---------------- route ---------------- */

router.post('/apply-week', async (req, res) => {
  const db = getDb(req);
  if (!db){
    return res.status(500).json({
      ok:false,
      error:'DB not attached. In app.js call app.set("db", db) or rely on route’s local Pool.'
    });
  }

  try{
    const season  = Number(req.body && req.body.season) || new Date().getFullYear();
    const week    = Number(req.body && req.body.week);
    if (!Number.isFinite(week) || week < 1 || week > 18) {
      return res.status(400).json({ ok:false, error:'Invalid `week` (1–18).' });
    }

    const leagues = await getAllLeagues(db, season);
    if (!leagues.length) return res.status(404).json({ ok:false, error:'No leagues for season.' });

    const summary = [];

    for (const leagueId of leagues){
      // scoring label per league (PPR/HALF/STD/LEAGUE)
      const scoring = await detectScoringLabel(req, season, leagueId);

      // Prepare a fetcher for team discovery fallback
      const rosterFetch = (args) => fetchRoster(req, { season, week, leagueId, ...args });

      const teams = await getTeamsForLeague(db, season, leagueId, rosterFetch);

      for (const t of teams){
        let roster;
        try {
          roster = await rosterFetch({ teamId: t.team_id });
        } catch (e) {
          summary.push({ leagueId, teamId: t.team_id, error: `roster: ${e.message}` });
          continue;
        }

        const players = roster.players || (roster.team && roster.team.players) || roster || [];
        const startersRaw = players.filter(p =>
          p.isStarter ||
          ['QB','RB','WR','TE','FLEX','K','DST'].includes(String(p.slot || '').toUpperCase())
        );

        const starters = startersRaw.map(toStarterRow).map(s => {
          // Find original source player to read points
          const src = players.find(pp => Number(pp.playerId ?? pp.id) === s.id) || {};
          const pts = Number(
            (src.appliedPoints ?? src.applied_points ?? src.points ?? src.applied ?? 0)
          );
          return { ...s, pts: Number((pts || 0).toFixed(2)) };
        });

        const points = Number(starters.reduce((a,b)=> a + (b.pts || 0), 0).toFixed(2));

        await upsertTeamWeek(db, {
          season, league_id: leagueId, team_id: t.team_id,
          week, scoring, team_name: roster.team_name || t.team_name || '',
          starters, points
        });

        summary.push({ leagueId, teamId: t.team_id, scoring, count: starters.length, points });
      }
    }

    res.json({ ok:true, season, week, updated: summary.length, summary });
  } catch (err){
    console.error('apply-week error', err);
    res.status(500).json({ ok:false, error: String(err.message || err) });
  }
});

module.exports = router;
