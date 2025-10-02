// routes/pp/teams.js
// Mount with: app.use('/api/pp', require('./routes/pp/teams'));

const express = require('express');
let db = require('../../src/db/pool');
let pool = db.pool || db;

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pp/teams] pg pool missing/invalid import');
}

const router = express.Router();

// map any platform input to the set of equivalent codes we store
function platformAliases(p) {
  if (!p) return null;
  const v = String(p).toLowerCase().trim();
  // ESPN shows up in our DB both ways ('018' and 'espn')
  if (v === '018' || v === 'espn') return ['018', 'espn'];
  return [v];
}

/**
 * GET /api/pp/teams
 * Query params:
 *  - sport      default: 'ffl'
 *  - season     default: current UTC year
 *  - platform   optional (e.g., '018' or 'espn'); aliases handled
 *  - handle     optional
 *  - member_id  optional
 *  - visibility optional (if omitted, do NOT filter on it)
 *  - status     optional (if omitted, do NOT filter on it)
 *
 * NOTE: We DO NOT hard-filter visibility/status anymore. If you want that,
 * pass visibility=public&status=active explicitly.
 */
router.get('/teams', async (req, res) => {
  try {
    const sport      = String(req.query.sport || 'ffl').toLowerCase();
    const season     = Number(req.query.season || new Date().getUTCFullYear());
    const platformIn = req.query.platform ? String(req.query.platform) : null;
    const handle     = req.query.handle ? String(req.query.handle) : null;
    const memberId   = req.query.member_id ? String(req.query.member_id) : null;

    // optional filters (ONLY applied if provided)
    const visibility = req.query.visibility != null ? String(req.query.visibility) : null;
    const status     = req.query.status     != null ? String(req.query.status)     : null;

    if (sport !== 'ffl') {
      return res.status(400).json({ ok:false, error:'Unsupported sport for this endpoint' });
    }

    const conds = ['season = $1'];
    const params = [season];
    let p = 2;

    // platform aliases (e.g., 018 <-> espn)
    const plats = platformAliases(platformIn);
    if (plats) { conds.push(`platform = ANY($${p++}::text[])`); params.push(plats); }

    if (handle)   { conds.push(`handle = $${p++}`);     params.push(handle); }
    if (memberId) { conds.push(`member_id = $${p++}`);  params.push(memberId); }

    // Only constrain on visibility/status if explicitly passed.
    // If you prefer treating NULL as a default, uncomment the COALESCE lines below.
    if (visibility != null) { conds.push(`visibility = $${p++}`); params.push(visibility); }
    if (status     != null) { conds.push(`status = $${p++}`);     params.push(status); }

    // Alternative (treat NULL as defaults):
    // if (visibility != null) { conds.push(`COALESCE(visibility,'public') = $${p++}`); params.push(visibility); }
    // if (status     != null) { conds.push(`COALESCE(status,'active')     = $${p++}`); params.push(status); }

    const sql = `
      SELECT
        season,
        league_id::text  AS "leagueId",
        team_id::text    AS "teamId",
        NULLIF(team_name,'')                    AS "teamNameRaw",
        COALESCE(league_name,'League')          AS "leagueName",
        COALESCE(league_size,0)                 AS "leagueSize",
        COALESCE(team_logo_url,'')              AS "logo"
      FROM ff_sport_ffl
      WHERE ${conds.join(' AND ')}
      ORDER BY league_id::text, team_id::text
    `;

    const { rows } = await pool.query(sql, params);

    // better fallback for empty names
    const teams = rows.map(r => ({
      season,
      leagueId: r.leagueId,
      teamId:   r.teamId,
      teamName: r.teamNameRaw || `Team ${r.teamId}`,
      leagueName: r.leagueName,
      leagueSize: r.leagueSize,
      logo: r.logo,
    }));

    return res.json({ ok:true, season, sport, count: teams.length, teams });
  } catch (err) {
    console.error('[pp/teams] error', err);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
