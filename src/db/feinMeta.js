// src/db/feinMeta.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

/**
 * Upsert by (season, platform, league_id, team_id).
 * Unknown fields can be null; they’ll be filled by later sync jobs.
 */
async function upsertFeinMeta({
  season,
  platform = 'espn',
  league_id,
  team_id,
  name = null,
  handle = null,
  league_size = null,
  fb_groups = null,
  swid = null,
  espn_s2 = null,
}) {
  const updated_at = new Date().toISOString();

  const sql = `
    INSERT INTO fein_meta (
      season, platform, league_id, team_id,
      name, handle, league_size, fb_groups,
      swid, espn_s2, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (season, platform, league_id, team_id)
    DO UPDATE SET
      name        = COALESCE(EXCLUDED.name, fein_meta.name),
      handle      = COALESCE(EXCLUDED.handle, fein_meta.handle),
      league_size = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
      fb_groups   = COALESCE(EXCLUDED.fb_groups, fein_meta.fb_groups),
      swid        = COALESCE(EXCLUDED.swid, fein_meta.swid),
      espn_s2     = COALESCE(EXCLUDED.espn_s2, fein_meta.espn_s2),
      updated_at  = EXCLUDED.updated_at
    RETURNING
      id, season, platform, league_id, team_id,
      name, handle, league_size, fb_groups, updated_at
  `;

  const params = [
    season, platform, String(league_id), String(team_id),
    name, handle, league_size, fb_groups,
    swid, espn_s2, updated_at,
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

module.exports = { upsertFeinMeta, getFeinMetaByKey };
