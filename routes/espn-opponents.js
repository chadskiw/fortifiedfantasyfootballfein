// routes/espn-opponents.js
// Fortified Fantasy — safe proxies for opponents + rosters (players only)
// Adds league-wide endpoints that use ONE valid team’s creds for the league.
// Depends on: ../src/db exporting `query` and Postgres table `fein_meta` with swid/s2.

const express = require('express');
const { query } = require('../src/db');

const router = express.Router();

/* ------------------------------- helpers -------------------------------- */

const ok   = (res, data) => res.json({ ok: true, ...data });
const bad  = (res, msg)  => res.status(400).json({ ok: false, error: msg || 'Bad request' });
const boom = (res, err)  => res.status(500).json({ ok: false, error: String(err?.message || err) });

const s = v => (v == null ? '' : String(v));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };

function ensureBracedSwid(w) {
  const t = s(w).trim();
  if (!t) return '';
  if (/^\{.*\}$/.test(t)) return t;
  return `{${t.replace(/^\{|\}$/g, '')}}`;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) return { ok:false, status:res.status, error:'Non-200 from upstream', data };
    return { ok:true, status:res.status, data };
  } catch (e) {
    return { ok:false, status:res.status, error:'Invalid JSON from upstream', data:text.slice(0,1000) };
  }
}

// Pull best creds for a given league/team, with season preference.
// If teamId is omitted, returns the most recent valid creds in that league (optionally for season).
async function getCreds({ leagueId, teamId, season }) {
  const lid = s(leagueId).trim();
  const tid = s(teamId).trim();
  const yr  = s(season).trim();

  const tries = [];
  if (lid && tid && yr) {
    tries.push({ sql: `
      SELECT swid, s2 FROM fein_meta
      WHERE league_id = $1 AND team_id = $2 AND season = $3
        AND swid IS NOT NULL AND s2 IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `, params: [lid, tid, yr] });
  }
  if (lid && tid) {
    tries.push({ sql: `
      SELECT swid, s2 FROM fein_meta
      WHERE league_id = $1 AND team_id = $2
        AND swid IS NOT NULL AND s2 IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `, params: [lid, tid] });
  }
  if (lid && yr) {
    tries.push({ sql: `
      SELECT swid, s2 FROM fein_meta
      WHERE league_id = $1 AND season = $2
        AND swid IS NOT NULL AND s2 IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `, params: [lid, yr] });
  }
  if (lid) {
    tries.push({ sql: `
      SELECT swid, s2 FROM fein_meta
      WHERE league_id = $1
        AND swid IS NOT NULL AND s2 IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `, params: [lid] });
  }

  for (const t of tries) {
    const rows = await query(t.sql, t.params).then(r => r.rows);
    const r = rows?.[0];
    if (r?.swid && r?.s2) {
      return { swid: ensureBracedSwid(r.swid), s2: s(r.s2) };
    }
  }
  return { swid:'', s2:'' };
}

// ESPN league URL with matchup + team + roster views.
function espnLeagueUrl({ season, leagueId, week, forTeamId }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const sp = new URLSearchParams();
  if (week) sp.set('scoringPeriodId', String(week));
  if (forTeamId) sp.set('forTeamId', String(forTeamId));
  ['mMatchup','mTeam','mRoster','kona_player_info'].forEach(v => sp.append('view', v));
  return `${base}?${sp.toString()}`;
}

// Same, but no forTeamId (pull league-wide in one go when creds allow)
function espnLeagueUrlAll({ season, leagueId, week }) {
  return espnLeagueUrl({ season, leagueId, week, forTeamId: null });
}

// Normalize abbrevs
const TEAM_NORM = { JAC: 'JAX', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR', LA: 'LAR' };
function normAbbr(a) {
  const t = String(a||'').toUpperCase().replace(/[^A-Z]/g,'');
  return TEAM_NORM[t] || t || null;
}

/* -------------------------------- ROUTES -------------------------------- */
/** SINGLE-TEAM: opponent for week */
router.get('/opponent', async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const teamId   = s(req.query.teamId   || req.query.tid).trim();
    const season   = s(req.query.season   || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId);

    if (!leagueId || !teamId || !season || !week) {
      return bad(res, 'leagueId, teamId, season, week required');
    }

    const { swid, s2 } = await getCreds({ leagueId, teamId, season });
    if (!swid || !s2) return res.status(401).json({ ok:false, error:'No stored ESPN creds for that team/league' });

    const url = espnLeagueUrl({ season, leagueId, week, forTeamId: teamId });
    const espn = await fetchJson(url, {
      headers: {
        'accept': 'application/json',
        'cookie': `espn_s2=${s2}; SWID=${swid}`,
        'referer': `https://fantasy.espn.com/football/team?leagueId=${leagueId}`,
        'origin': 'https://fantasy.espn.com',
        'user-agent': 'Mozilla/5.0 FortifiedFantasy/1.0'
      }
    });

    if (!espn.ok) {
      return res.status(502).json({ ok:false, error:'Upstream (ESPN) error', status:espn.status, upstream:espn.data });
    }

    const data = espn.data || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const schedule = Array.isArray(data.schedule) ? data.schedule : [];

    const match = schedule.find(m =>
      Number(m?.matchupPeriodId) === Number(week) &&
      (String(m?.home?.teamId) === String(teamId) || String(m?.away?.teamId) === String(teamId))
    );

    if (!match) {
      return ok(res, { meta: { leagueId, season:Number(season), week:Number(week), teamId }, opponent: null });
    }

    const isHome = String(match?.home?.teamId) === String(teamId);
    const opponentId = String(isHome ? match?.away?.teamId : match?.home?.teamId);

    const t = teams.find(t => String(t?.id) === opponentId) || null;
    const opponent = t ? {
      id: t.id,
      abbrev: t.abbrev || null,
      name: t.location && t.nickname ? `${t.location} ${t.nickname}` : (t.nickname || t.location || t.name || null),
      logo: t.logo || null,
      owners: t.owners || [],
    } : { id: Number(opponentId) };

    return ok(res, {
      meta: { leagueId, teamId, season:Number(season), week:Number(week) },
      opponent
    });

  } catch (e) { return boom(res, e); }
});

/** SINGLE-TEAM: roster (players only) */
router.get('/roster-players', async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const teamId   = s(req.query.teamId   || req.query.tid).trim();
    const season   = s(req.query.season   || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId);

    if (!leagueId || !teamId || !season || !week) {
      return bad(res, 'leagueId, teamId, season, week required');
    }

    const { swid, s2 } = await getCreds({ leagueId, teamId, season });
    if (!swid || !s2) return res.status(401).json({ ok:false, error:'No stored ESPN creds for that team/league' });

    const url = espnLeagueUrl({ season, leagueId, week, forTeamId: teamId });
    const espn = await fetchJson(url, {
      headers: {
        'accept': 'application/json',
        'cookie': `espn_s2=${s2}; SWID=${swid}`,
        'referer': `https://fantasy.espn.com/football/team?leagueId=${leagueId}`,
        'origin': 'https://fantasy.espn.com',
        'user-agent': 'Mozilla/5.0 FortifiedFantasy/1.0'
      }
    });

    const flat = String(req.query.flat || '') === '1';
if (flat) {
  const byTeamId = {};
  for (const row of out) byTeamId[String(row.team.id)] = row.players;
  return ok(res, {
    meta: { leagueId, season: Number(season), week: Number(week), usingTeamId: usingTeamId || null, flat: true },
    playersByTeamId: byTeamId
  });
}


    const data = espn.data || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const me = teams.find(t => String(t?.id) === String(teamId)) || null;
    const entries = me?.roster?.entries || [];

    const players = entries.map(e => {
      const p = e?.playerPoolEntry?.player || e?.player || {};
      const name = p?.fullName || `${p?.firstName||''} ${p?.lastName||''}`.trim();
      const lineupSlotId = Number(e?.lineupSlotId);
      const posId = Number(p?.defaultPositionId);
      const pro = normAbbr(p?.proTeamAbbreviation || p?.proTeamAbbr);
      let proj = 0;
      if (Array.isArray(p?.stats)) {
        const row = p.stats.find(s => Number(s?.scoringPeriodId) === Number(week) && Number(s?.statSourceId) === 1);
        proj = Number.isFinite(row?.appliedTotal) ? Number(row.appliedTotal) : 0;
      }
      return {
        playerId: Number(p?.id),
        name,
        positionId: Number.isFinite(posId) ? posId : null,
        lineupSlotId: Number.isFinite(lineupSlotId) ? lineupSlotId : null,
        proTeamAbbr: pro,
        injuryStatus: p?.injuryStatus || null,
        proj
      };
    });

    return ok(res, {
      meta: { leagueId, teamId, season:Number(season), week:Number(week) },
      players
    });

  } catch (e) { return boom(res, e); }
});

/** LEAGUE-WIDE: opponents for week (for ALL teams) */
router.get('/league-opponents', async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const season   = s(req.query.season   || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId);
    const usingTeamId = s(req.query.usingTeamId || req.query.teamId || '').trim(); // optional creds chooser

    if (!leagueId || !season || !week) {
      return bad(res, 'leagueId, season, week required');
    }

    const { swid, s2 } = await getCreds({ leagueId, teamId: usingTeamId, season });
    if (!swid || !s2) return res.status(401).json({ ok:false, error:'No stored ESPN creds for that league' });

    const url = espnLeagueUrlAll({ season, leagueId, week });
    const espn = await fetchJson(url, {
      headers: {
        'accept': 'application/json',
        'cookie': `espn_s2=${s2}; SWID=${swid}`,
        'referer': `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
        'origin': 'https://fantasy.espn.com',
        'user-agent': 'Mozilla/5.0 FortifiedFantasy/1.0'
      }
    });

    if (!espn.ok) {
      return res.status(502).json({ ok:false, error:'Upstream (ESPN) error', status:espn.status, upstream:espn.data });
    }

    const data = espn.data || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const schedule = Array.isArray(data.schedule) ? data.schedule : [];

    // Build map of teamId -> opponentId for the requested week
    const opponents = {};
    const matchups = schedule.filter(m => Number(m?.matchupPeriodId) === Number(week));
    for (const m of matchups) {
      const homeId = Number(m?.home?.teamId);
      const awayId = Number(m?.away?.teamId);
      if (Number.isFinite(homeId) && Number.isFinite(awayId)) {
        opponents[String(homeId)] = awayId;
        opponents[String(awayId)] = homeId;
      }
    }

    // Shape output with light meta for each team + opponent meta if available
    const teamsOut = teams.map(t => {
      const oppId = opponents[String(t.id)] ?? null;
      const opp = oppId != null ? teams.find(x => Number(x.id) === Number(oppId)) : null;
      const meta = (TT) => TT && {
        id: TT.id,
        abbrev: TT.abbrev || null,
        name: TT.location && TT.nickname ? `${TT.location} ${TT.nickname}` : (TT.nickname || TT.location || TT.name || null),
        logo: TT.logo || null,
        owners: TT.owners || []
      } || null;

      return {
        team: meta(t),
        opponent: meta(opp)
      };
    });

    return ok(res, {
      meta: { leagueId, season:Number(season), week:Number(week), usingTeamId: usingTeamId || null },
      teams: teamsOut
    });

  } catch (e) { return boom(res, e); }
});

/** LEAGUE-WIDE: rosters (players only) for ALL teams */
router.get('/league-rosters', async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const season   = s(req.query.season   || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId);
    const usingTeamId = s(req.query.usingTeamId || req.query.teamId || '').trim(); // optional creds chooser

    if (!leagueId || !season || !week) {
      return bad(res, 'leagueId, season, week required');
    }

    const { swid, s2 } = await getCreds({ leagueId, teamId: usingTeamId, season });
    if (!swid || !s2) return res.status(401).json({ ok:false, error:'No stored ESPN creds for that league' });

    const url = espnLeagueUrlAll({ season, leagueId, week });
    const espn = await fetchJson(url, {
      headers: {
        'accept': 'application/json',
        'cookie': `espn_s2=${s2}; SWID=${swid}`,
        'referer': `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
        'origin': 'https://fantasy.espn.com',
        'user-agent': 'Mozilla/5.0 FortifiedFantasy/1.0'
      }
    });

    if (!espn.ok) {
      return res.status(502).json({ ok:false, error:'Upstream (ESPN) error', status:espn.status, upstream:espn.data });
    }

    const data = espn.data || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];

    // Normalize per team
    const out = teams.map(T => {
      const entries = T?.roster?.entries || [];
      const players = entries.map(e => {
        const p = e?.playerPoolEntry?.player || e?.player || {};
        const name = p?.fullName || `${p?.firstName||''} ${p?.lastName||''}`.trim();
        const lineupSlotId = Number(e?.lineupSlotId);
        const posId = Number(p?.defaultPositionId);
        const pro = normAbbr(p?.proTeamAbbreviation || p?.proTeamAbbr);
        let proj = 0;
        if (Array.isArray(p?.stats) && Number.isFinite(week)) {
          const row = p.stats.find(s => Number(s?.scoringPeriodId) === Number(week) && Number(s?.statSourceId) === 1);
          proj = Number.isFinite(row?.appliedTotal) ? Number(row.appliedTotal) : 0;
        }
        return {
          playerId: Number(p?.id),
          name,
          positionId: Number.isFinite(posId) ? posId : null,
          lineupSlotId: Number.isFinite(lineupSlotId) ? lineupSlotId : null,
          proTeamAbbr: pro,
          injuryStatus: p?.injuryStatus || null,
          proj
        };
      });

      const teamMeta = {
        id: T.id,
        abbrev: T.abbrev || null,
        name: T.location && T.nickname ? `${T.location} ${T.nickname}` : (T.nickname || T.location || T.name || null),
        logo: T.logo || null,
        owners: T.owners || []
      };

      return { team: teamMeta, players };
    });

    return ok(res, {
      meta: { leagueId, season:Number(season), week:Number(week), usingTeamId: usingTeamId || null },
      teams: out
    });

  } catch (e) { return boom(res, e); }
});

module.exports = router;
