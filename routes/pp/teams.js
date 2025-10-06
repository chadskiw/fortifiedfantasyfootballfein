// routes/pp/teams.js
// Mount with: app.use('/api/pp', require('./routes/pp/teams'));

const express = require('express');
let db = require('../../src/db/pool');
let pool = db.pool || db;

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pp/teams] pg pool missing/invalid import');
}

const router = express.Router();

// Normalize platform inputs to the set of codes we store
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
 *  - week       optional (number). If provided, returns a roster snapshot
 *               from ff_sport_ffl.scoring_json for that scoring period.
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

    // optional week (for roster snapshot)
    const week = req.query.week != null ? Number(req.query.week) : null;
    const hasWeek = Number.isFinite(week) && week > 0;

    if (sport !== 'ffl') {
      return res.status(400).json({ ok:false, error:'Unsupported sport for this endpoint' });
    }

    const conds = ['f.season = $1'];
    const params = [season];
    let p = 2;

    // platform aliases (e.g., 018 <-> espn)
    const plats = platformAliases(platformIn);
    if (plats) { conds.push(`f.platform = ANY($${p++}::text[])`); params.push(plats); }

    if (handle)   { conds.push(`f.handle = $${p++}`);     params.push(handle); }
    if (memberId) { conds.push(`f.member_id = $${p++}`);  params.push(memberId); }

    // Only constrain on visibility/status if explicitly passed
    if (visibility != null) { conds.push(`f.visibility = $${p++}`); params.push(visibility); }
    if (status     != null) { conds.push(`f.status     = $${p++}`); params.push(status); }

    // Dynamic select list: include roster_json when week is requested
    const selectRoster =
      hasWeek
        ? `, f.scoring_json -> $${p++} AS roster_json`
        : `, NULL::jsonb AS roster_json`;
    if (hasWeek) params.push(String(week)); // JSONB key is text

    const sql = `
      SELECT
        f.season,
        f.platform,
        f.league_id::text                       AS "leagueId",
        f.team_id::text                         AS "teamId",
        NULLIF(f.team_name,'')                  AS "teamNameRaw",
        COALESCE(f.league_name,'League')        AS "leagueName",
        COALESCE(f.league_size,0)               AS "leagueSize",
        COALESCE(f.team_logo_url,'')            AS "logo",
        -- owner badge join
        q.handle                                AS "ownerHandle",
        q.color_hex                             AS "ownerColorHex",
        CASE
          WHEN q.image_key IS NOT NULL AND q.image_key <> ''
            THEN ('https://img.fortifiedfantasy.com/' || q.image_key)
          ELSE NULL
        END                                     AS "ownerBadgeUrl"
        ${selectRoster}
      FROM ff_sport_ffl f
      LEFT JOIN ff_quickhitter q
        ON q.member_id = f.member_id
      WHERE ${conds.join(' AND ')}
      ORDER BY f.league_id::text, f.team_id::text
    `;

    const { rows } = await pool.query(sql, params);

    const teams = rows.map(r => {
      // normalize team name
      const teamName = r.teamNameRaw || `Team ${r.teamId}`;

      // normalize badge URL (avoid accidental //)
      let ownerBadgeUrl = r.ownerBadgeUrl || '';
      if (ownerBadgeUrl.startsWith('https://img.fortifiedfantasy.com//')) {
        ownerBadgeUrl = ownerBadgeUrl.replace('https://img.fortifiedfantasy.com//','https://img.fortifiedfantasy.com/');
      }

      const base = {
        season,
        leagueId: r.leagueId,
        teamId:   r.teamId,
        teamName,
        leagueName: r.leagueName,
        leagueSize: r.leagueSize,
        logo: r.logo,

        // owner fields (reused by PP + Opponents + Roster)
        ownerHandle:   r.ownerHandle || null,
        ownerColorHex: r.ownerColorHex || null,
        ownerBadgeUrl: ownerBadgeUrl || null,
      };

      // If a week was requested and we have roster_json, pass it along
      if (hasWeek && r.roster_json != null) {
        base.roster = r.roster_json; // JSONB already parsed
      }

      return base;
    });

    return res.json({
      ok: true,
      sport,
      season,
      ...(hasWeek ? { week } : {}),
      count: teams.length,
      teams
    });
  } catch (err) {
    console.error('[pp/teams] error', err);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
