// routes/pp/teams.js
// Mount with: app.use('/api/pp', require('./routes/pp/teams'));

const express = require('express');
let db = require('../../src/db/pool');
let pool = db.pool || db;

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pp/teams] pg pool missing/invalid import');
}

const router = express.Router();

function mapPlatform(p) {
  if (!p) return null;
  const v = String(p).trim().toLowerCase();
  if (v === '018' || v === 'espn' || v === 'es') return 'espn';
  return v; // extend later if you add more providers
}

/**
 * GET /api/pp/teams
 * Query params:
 *  - sport:       ffl|flb|fba|fhl   (default: ffl)
 *  - season:      number            (default: current year)
 *  - platform:    'espn' or '018'   (optional; defaults to any)
 *  - leagueId:    string            (optional)
 *  - onlyMine:    true|false        (default: false)
 *  - excludeGhosts: true|false      (default: false)
 *  - size:        int (1..500)      (default: 100)
 *  - visibility:  string            (default: 'public')
 *  - status:      string            (default: 'active')
 *
 * Response:
 *  { ok, season, sport, count, teams: [{ season, leagueId, teamId, teamName, leagueName, leagueSize, logo }] }
 */
router.get('/teams', async (req, res) => {
  try {
    const sport       = String(req.query.sport || 'ffl').toLowerCase();
    const season      = Number(req.query.season || new Date().getUTCFullYear());
    const platformArg = mapPlatform(req.query.platform || null); // maps 018 -> espn
    const leagueId    = req.query.leagueId ? String(req.query.leagueId) : null;

    const onlyMine       = String(req.query.onlyMine || '').toLowerCase() === 'true';
    const excludeGhosts  = String(req.query.excludeGhosts || '').toLowerCase() === 'true';
    // legacy param still honored: includeGhosts=false -> excludeGhosts=true
    const includeGhostsQ = String(req.query.includeGhosts || '').toLowerCase();
    const legacyExcl     = (includeGhostsQ === 'false');

    const visibility  = String(req.query.visibility || 'public');
    const status      = String(req.query.status || 'active');
    const limit       = Math.min(Math.max(parseInt(req.query.size || '100', 10), 1), 500);

    // For "onlyMine", we need member_id from auth cookie/session; allow pass-through via query too.
    const memberIdQ = req.query.member_id ? String(req.query.member_id) : null;
    const memberId  = memberIdQ; // if you have a getAuthedMemberId(req), use it here instead.

    // Supported tables: default to ffl; easy to extend for others.
    const table = `ff_sport_${sport}`;
    if (!['ffl','flb','fba','fhl'].includes(sport)) {
      return res.status(400).json({ ok:false, error:'Unsupported sport for this endpoint' });
    }

    // WHERE: base conditions
    const whereParts = ['s.season = $1', 's.visibility = $2', 's.status = $3'];
    const params = [season, visibility, status];
    let p = 4;

    if (platformArg) { whereParts.push(`s.platform = $${p++}`); params.push(platformArg); }
    if (leagueId)    { whereParts.push(`s.league_id = $${p++}`); params.push(leagueId); }

    // Ownership filters (LEFT JOIN so rows still appear if no owner record)
    const ownerFilters = [];
    if (onlyMine) {
      if (!memberId) {
        return res.json({ ok:true, season, sport, count: 0, teams: [] });
      }
      ownerFilters.push(`o.member_id = $${p++}`);
      params.push(memberId);
    }
    if (excludeGhosts || legacyExcl) {
      ownerFilters.push(`(o.owner_kind IS DISTINCT FROM 'ghost')`);
    }
    const ownerClause = ownerFilters.length ? `AND ${ownerFilters.join(' AND ')}` : '';

    const sql = `
      SELECT
        s.season,
        s.league_id::text  AS "leagueId",
        s.team_id::text    AS "teamId",
        COALESCE(s.team_name,'Team')      AS "teamName",
        COALESCE(s.league_name,'League')  AS "leagueName",
        COALESCE(s.league_size,0)         AS "leagueSize",
        COALESCE(s.team_logo_url,'')      AS "logo"
      FROM ${table} s
      LEFT JOIN ff_team_owner o
        ON o.platform = s.platform
       AND o.season   = s.season
       AND o.league_id= s.league_id
       AND o.team_id  = s.team_id
      WHERE ${whereParts.join(' AND ')}
      ${ownerClause}
      ORDER BY s.season DESC,
               s.league_id::text,
               NULLIF(s.team_id,'')::int NULLS LAST, s.team_id
      LIMIT $${p}
    `;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    return res.json({ ok:true, season, sport, count: rows.length, teams: rows });
  } catch (err) {
    console.error('[pp/teams] error', err);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
