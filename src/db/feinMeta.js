// TRUE_LOCATION: src/db/feinMeta.js
// IN_USE: TRUE
// src/db/feinMeta.js
// src/db/feinMeta.js
const { Pool } = require('pg');
const { create: createId, dissect } = require('../../lib/idCodec.js');

// server/routes/fein-meta.js
const express = require('express');
const router = express.Router();

// Parse both JSON and form
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

/**
 * Upsert by (season, platform, league_id, team_id).
 * Unknown fields can be null; they’ll be filled by later sync jobs.
 */
async function upsertFeinMeta({
  user_id,
  season,
  platform = 'espn',
  sport = 'ffl',
  league_id,
  team_id,
  name = null,
  handle = null,
  league_size = null,
  fb_groups = null,

}) {
  const updated_at = new Date().toISOString();

  // 🔑 generate the canonical 21-digit id
  const id = createId({ platform, season, leagueId: league_id, teamId: team_id });

  const sql = `
    INSERT INTO fein_meta (
      id, platform, sport, season, league_id, team_id,
      name, handle, league_size, fb_groups, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id, platform, sport, season, league_id, team_id)
    DO UPDATE SET
      name        = COALESCE(EXCLUDED.name, fein_meta.name),
      handle      = COALESCE(EXCLUDED.handle, fein_meta.handle),
      league_size = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
      fb_groups   = COALESCE(EXCLUDED.fb_groups, fein_meta.fb_groups),
      updated_at  = EXCLUDED.updated_at
    RETURNING
      user_id, platform, sport, season,  league_id, team_id,
      name, handle, league_size, fb_groups, updated_at
  `;

  const params = [
    user_id, platform, sport, season, String(league_id), String(team_id),
    name, handle, league_size, fb_groups, updated_at,
  ];

  const { rows } = await pool.query(sql, params);
  return rows[0];
}


/** Fetch a specific row by its natural key. */
async function getFeinMetaByKey({ season, platform = 'espn', league_id, team_id }) {
  const sql = `
    SELECT id, season, platform, league_id, team_id,
           name, handle, league_size, fb_groups, updated_at
    FROM fein_meta
    WHERE season = $1 AND platform = $2 AND league_id = $3 AND team_id = $4
    LIMIT 1
  `;
  const params = [season, platform, String(league_id), String(team_id)];
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

function detectSportFromLeague(L) {
  const u = String(L?.scoreboardFeedURL || L?.fantasyCastHref || L?.href || L?.entryURL || '');
  const m = u.match(/\/games\/([a-z]{3})\b/i); // e.g. /games/ffl/, /games/flb/, /games/fba/
  return (m && m[1].toLowerCase()) || 'ffl';
}



/**
 * POST /api/fein-auth/fein/meta/upsert
 * Accepts: season, platform ('espn'), league_id, team_id, name?, handle?, league_size?, fb_groups?
 * Reads SWID / espn_s2 from cookies (HttpOnly on your domain)
 */
router.post('/fein/meta/upsert', async (req, res) => {
  try {
    const {
      season,
      platform = 'espn',
      sport = 'ffl',
      league_id,
      team_id,
      name = null,
      handle = null,
      league_size = null,
      fb_groups = null,
    } = req.body || {};

    if (!season || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'missing season/league_id/team_id' });
    }

    // Pull ESPN cookies set by your auth flow (HttpOnly on fortifiedfantasy.com)
    const swid   = req.cookies?.SWID     || null;
    const espn_s2 = req.cookies?.espn_s2 || req.cookies?.ESPN_S2 || null;

    const row = await upsertFeinMeta({
      user_id,
      season: Number(season),
      platform,
      sport,
      league_id,
      team_id,
      name,
      handle,
      league_size: league_size != null ? Number(league_size) : null,
      fb_groups,
    });

    return res.status(200).json({ ok: true, meta: row });
  } catch (e) {
    console.error('[fein-meta upsert] error:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Optional GET for debugging */
router.get('/fein/meta', async (req, res) => {
  try {
    const { season, platform = 'espn', league_id, team_id } = req.query || {};
    if (!season || !league_id || !team_id) {
      return res.status(400).json({ ok:false, error:'missing season/league_id/team_id' });
    }
    const row = await getFeinMetaByKey({ season: Number(season), platform, league_id, team_id });
    return res.json({ ok:true, meta: row });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

module.exports = router;







//module.exports = { upsertFeinMeta, getFeinMetaByKey };
