// routes/pp/teams.js
const express = require('express');
let db = require('../../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') throw new Error('[pp/teams] pg pool missing/invalid import');
const router = express.Router();

function mapPlatform(p) {
  if (!p) return null;
  const v = String(p).trim().toLowerCase();
  if (v === '018' || v === 'espn' || v === 'es') return 'espn';
  return v;
}

router.get('/teams', async (req, res) => {
  try {
    const sport       = String(req.query.sport || 'ffl').toLowerCase();
    const season      = Number(req.query.season || new Date().getUTCFullYear());
    const platformArg = mapPlatform(req.query.platform || null);
    const leagueId    = req.query.leagueId ? String(req.query.leagueId) : null;

    const onlyMine       = String(req.query.onlyMine || '').toLowerCase() === 'true';
    const excludeGhosts  = String(req.query.excludeGhosts || '').toLowerCase() === 'true';
    const includeGhostsQ = String(req.query.includeGhosts || '').toLowerCase();
    const legacyExcl     = (includeGhostsQ === 'false');

    // IMPORTANT: do not default these — only filter if the client asks
    const visibility = req.query.visibility ? String(req.query.visibility) : null;
    const status     = req.query.status ? String(req.query.status) : null;

    const limit       = Math.min(Math.max(parseInt(req.query.size || '100', 10), 1), 500);
    const memberId    = req.query.member_id ? String(req.query.member_id) : null;

    if (!['ffl','flb','fba','fhl'].includes(sport)) {
      return res.status(400).json({ ok:false, error:'Unsupported sport for this endpoint' });
    }
    const table = `ff_sport_${sport}`;

    // Base WHERE: season required; other filters optional
    const whereParts = ['s.season = $1'];
    const params = [season];
    let p = 2;

    if (platformArg) { whereParts.push(`s.platform = $${p++}`); params.push(platformArg); }
    if (leagueId)    { whereParts.push(`s.league_id::text = $${p++}`); params.push(leagueId); }
    if (visibility)  { whereParts.push(`s.visibility = $${p++}`); params.push(visibility); }
    if (status)      { whereParts.push(`s.status = $${p++}`);     params.push(status); }

    // Ownership filters (LEFT JOIN so teams with no owner row still appear)
    const ownerFilters = [];
    if (onlyMine) {
      if (!memberId) return res.json({ ok:true, season, sport, count:0, teams:[] });
      ownerFilters.push(`o.member_id = $${p++}`); params.push(memberId);
    }
    if (excludeGhosts || legacyExcl) ownerFilters.push(`(o.owner_kind IS DISTINCT FROM 'ghost')`);
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
        ON  o.platform = s.platform
        AND o.season   = s.season
        AND o.league_id::text = s.league_id::text
        AND o.team_id::text   = s.team_id::text
      WHERE ${whereParts.join(' AND ')}
      ${ownerClause}
      ORDER BY s.season DESC,
               s.league_id::text,
               NULLIF(s.team_id::text,'')::int NULLS LAST, s.team_id::text
      LIMIT $${p}
    `;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    res.set('Cache-Control','no-store');
    return res.json({ ok:true, season, sport, count: rows.length, teams: rows });
  } catch (err) {
    console.error('[pp/teams] error', err);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
