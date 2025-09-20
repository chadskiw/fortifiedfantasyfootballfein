// TRUE_LOCATION: src/routes/espn-proxy.js
// IN_USE: FALSE
// routes/espn-proxy.js
// Fortified Fantasy — ESPN credentialed proxies (server-side safe)
// Requires: ../src/db exports { query }, and your DB has fein_meta table w/ swid,s2.

const express = require('express');
const { query } = require('../src/db'); // <-- make sure this exists
const router = express.Router();

// ---------- helpers ----------
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
  } catch {
    return { ok:false, status:res.status, error:'Invalid JSON from upstream', data:text.slice(0,1000) };
  }
}

async function getCreds({ leagueId, teamId, season }) {
  // Prefer exact season + team row; fallback to latest for that team; then latest for league.
  const lid = s(leagueId).trim();
  const tid = s(teamId).trim();
  const yr  = s(season).trim();

  const trySQL = [];

  if (lid && tid && yr) {
    trySQL.push({
      sql: `
        SELECT swid, s2 FROM fein_meta
        WHERE league_id = $1 AND team_id = $2 AND season = $3
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      params: [lid, tid, yr]
    });
  }
  if (lid && tid) {
    trySQL.push({
      sql: `
        SELECT swid, s2 FROM fein_meta
        WHERE league_id = $1 AND team_id = $2
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      params: [lid, tid]
    });
  }
  if (lid && yr) {
    trySQL.push({
      sql: `
        SELECT swid, s2 FROM fein_meta
        WHERE league_id = $1 AND season = $2
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      params: [lid, yr]
    });
  }
  if (lid) {
    trySQL.push({
      sql: `
        SELECT swid, s2 FROM fein_meta
        WHERE league_id = $1
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      params: [lid]
    });
  }

  for (const t of trySQL) {
    const rows = await query(t.sql, t.params).then(r => r.rows);
    const r = rows?.[0];
    if (r?.swid && r?.s2) {
      return { swid: ensureBracedSwid(r.swid), s2: s(r.s2) };
    }
  }
  return { swid:'', s2:'' };
}

// ESPN URLs
function espnLeagueUrl({ season, leagueId, week, teamId }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const sp = new URLSearchParams();
  if (week) sp.set('scoringPeriodId', String(week));
  if (teamId) sp.set('forTeamId', String(teamId));
  // views needed for roster:
  ['mRoster','mTeam','mMatchup','kona_player_info'].forEach(v => sp.append('view', v));
  return `${base}?${sp.toString()}`;
}

function espnPlayersUrl({ season, leagueId, week }) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/players`;
  const sp = new URLSearchParams();
  if (week) sp.set('scoringPeriodId', String(week));
  sp.set('view', 'kona_player_info');
  sp.set('limit', '1000');
  sp.set('offset', '0');
  return `${base}?${sp.toString()}`;
}

function defaultFAFilter({ week, season, slotIds, statuses }) {
  const wk = Number(week);
  return {
    players: {
      filterStatus: { value: statuses || ['FREEAGENT','WAIVERS'] },
      filterSlotIds: { value: slotIds || [0,2,4,6,17,16] }, // QB,RB,WR,TE,K,DST
      sortPercOwned: { sortPriority: 2, sortAsc: false },
      sortDraftRanks: { sortPriority: 3, sortAsc: true, value: 'DEFAULT' },
      filterRanksForScoringPeriodIds: { value: [wk] },
      filterStatsForTopScoringPeriodIds: { value: [wk], additionalValue: ['00'+String(season), '10'+String(season)] }
    }
  };
}

// Normalize ESPN abbrevs a bit
const TEAM_NORM = { JAC: 'JAX', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR', LA: 'LAR' };
function normAbbr(a) {
  const t = String(a||'').toUpperCase().replace(/[^A-Z]/g,'');
  return TEAM_NORM[t] || t || null;
}

// ---------- ROUTES ----------

/**
 * GET /espn/opponent-roster?leagueId=...&teamId=...&season=...&week=...
 *
 * Uses THAT team’s stored swid/s2 to fetch the roster.
 * Returns a normalized, safe shape.
 */
router.get('/opponent-roster', async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const teamId   = s(req.query.teamId   || req.query.tid).trim();
    const season   = s(req.query.season   || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId) || null;

    if (!leagueId || !teamId || !season) return bad(res, 'leagueId, teamId, season required');

    // 1) Get creds for THAT team (or best available)
    const { swid, s2 } = await getCreds({ leagueId, teamId, season });
    if (!swid || !s2) {
      return res.status(401).json({ ok:false, error:'Missing ESPN auth (no stored credentials)' });
    }

    // 2) Hit ESPN
    const url = espnLeagueUrl({ season, leagueId, week, teamId });
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

    // 3) Normalize
    const data = espn.data || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const t = teams.find(t => String(t?.id) === String(teamId)) || teams[0] || null;

    const teamMeta = t ? {
      id: t.id,
      abbrev: t.abbrev || null,
      name: t.location && t.nickname ? `${t.location} ${t.nickname}` : (t.nickname || t.location || t.name || null),
      logo: t.logo || null,
      owners: t.owners || [],
      record: t.record || null
    } : null;

    const entries = t?.roster?.entries || [];
    const roster = entries.map(e => {
      const p = e?.playerPoolEntry?.player || e?.player || {};
      const posId = Number(p?.defaultPositionId);
      const lineupSlotId = Number(e?.lineupSlotId);
      const display = p?.fullName || (p?.firstName || '') + ' ' + (p?.lastName || '');
      const proTeamAbbr = normAbbr(p?.proTeamAbbreviation || p?.proTeamAbbr);
      let proj = 0;
      const wk = Number(week);
      if (Array.isArray(p?.stats) && wk) {
        const row = p.stats.find(s => Number(s?.scoringPeriodId) === wk && Number(s?.statSourceId) === 1);
        proj = Number.isFinite(row?.appliedTotal) ? Number(row.appliedTotal) : 0;
      }
      return {
        playerId: Number(p?.id),
        name: display?.trim() || null,
        positionId: Number.isFinite(posId) ? posId : null,
        lineupSlotId: Number.isFinite(lineupSlotId) ? lineupSlotId : null,
        proTeamAbbr,
        injuryStatus: p?.injuryStatus || null,
        proj
      };
    });

    return ok(res, {
      meta: { leagueId, teamId, season: Number(season), week: Number(week || 0) || null, source: 'espn' },
      team: teamMeta,
      roster
    });
  } catch (e) { return boom(res, e); }
});

/**
 * Shared handler for:
 *   GET /espn/free-agents-proxy
 *   GET /espn/free-agents         (alias)
 *
 * Uses the specified team’s creds (teamId/usingTeamId) to hit ESPN’s /players
 * and returns a simple normalized FA list. (No FMV math here).
 */
async function handleFreeAgents(req, res) {
  try {
    const leagueId = s(req.query.leagueId || req.query.league || req.query.lid).trim();
    const season   = s(req.query.season || req.query.year).trim();
    const week     = n(req.query.week || req.query.scoringPeriodId) || 1;

    // choose whose creds to use (clicked team or any valid in league)
    const teamId = s(req.query.teamId || req.query.usingTeamId || '').trim();

    if (!leagueId || !season) return bad(res, 'leagueId, season required');

    const { swid, s2 } = await getCreds({ leagueId, teamId, season });
    if (!swid || !s2) {
      return res.status(401).json({ ok:false, error:'Missing ESPN auth (no stored credentials)' });
    }

    const url = espnPlayersUrl({ season, leagueId, week });
    const filter = defaultFAFilter({
      week,
      season,
      slotIds: (s(req.query.slotIds).trim() ? s(req.query.slotIds).trim().split(',').map(x=>Number(x)) : [0,2,4,6,17,16]),
      statuses: (s(req.query.status).trim() ? s(req.query.status).trim().split(',').map(x=>x.toUpperCase()) : ['FREEAGENT','WAIVERS'])
    });

    const espn = await fetchJson(url, {
      headers: {
        'accept': 'application/json',
        'x-fantasy-filter': JSON.stringify(filter),
        'cookie': `espn_s2=${s2}; SWID=${swid}`,
        'referer': `https://fantasy.espn.com/football/team?leagueId=${leagueId}`,
        'origin': 'https://fantasy.espn.com',
        'user-agent': 'Mozilla/5.0 FortifiedFantasy/1.0'
      }
    });

    if (!espn.ok) {
      return res.status(502).json({ ok:false, error:'Upstream (ESPN) error', status:espn.status, upstream:espn.data });
    }

    const rows = Array.isArray(espn.data) ? espn.data : [];
    const out = rows.map(r => {
      const P = r?.player || r || {};
      const name = P?.fullName || `${P?.firstName||''} ${P?.lastName||''}`.trim();
      const pro = normAbbr(P?.proTeamAbbreviation || P?.proTeamAbbr);
      const posId = Number(P?.defaultPositionId);
      let proj = 0;
      if (Array.isArray(P?.stats)) {
        const row = P.stats.find(s => Number(s?.scoringPeriodId) === Number(week) && Number(s?.statSourceId) === 1);
        proj = Number.isFinite(row?.appliedTotal) ? Number(row.appliedTotal) : 0;
      }
      return {
        id: Number(P?.id),
        name,
        positionId: Number.isFinite(posId) ? posId : null,
        teamAbbr: pro,
        status: (r?.status || P?.status || 'FREEAGENT').toUpperCase(),
        percentOwned: Number(r?.ownership?.percentOwned ?? P?.ownership?.percentOwned ?? 0),
        proj
      };
    });

    return ok(res, {
      meta: { leagueId, season: Number(season), week: Number(week), usingTeamId: teamId || null },
      counts: { total: out.length },
      players: out
    });
  } catch (e) { return boom(res, e); }
}

// Mount both paths to the same handler
router.get('/free-agents-proxy', handleFreeAgents);
router.get('/free-agents',        handleFreeAgents);

module.exports = router;
