// TRUE_LOCATION: src/db/feinMeta.js
// IN_USE: TRUE
// CommonJS module exporting an Express router for FEIN meta upsert/read.
// Notes:
// - Keeps router export (so no server wiring changes needed)
// - Uses a single pg Pool in this module (simple, avoids .pool circulars)
// - Validates/normalizes inputs
// - Uses idCodec.createId() to generate canonical 21-digit id
// - ON CONFLICT on (id) only (adjust if your table uses a different unique key)

const express = require('express');
const { Pool } = require('pg');
const { create: createId /* dissect */ } = require('../../lib/idCodec.js');

const router = express.Router();

// Local parsers (safe even if app also sets them)
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

/* -------------------------- pg pool (singleton-ish) ------------------------- */
let _pool;
function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
  _pool.on('error', (err) => console.error('[pg pool error]', err));
  return _pool;
}

/* --------------------------------- helpers --------------------------------- */

function toStr(x) {
  if (x === undefined || x === null) return null;
  const s = String(x).trim();
  return s.length ? s : null;
}
function toInt(x) {
  if (x === undefined || x === null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Upsert by unique `id` (generated from platform+season+league_id+team_id).
 * Unknown fields can be null; later sync jobs can fill them.
 *
 * Table expectation (minimal):
 *   fein_meta(
 *     id text primary key,
 *     platform text,
 *     sport text,
 *     season int,
 *     league_id text,
 *     team_id text,
 *     name text,
 *     handle text,
 *     league_size int,
 *     fb_groups text,
 *     updated_at timestamptz
 *   )
 *
 * If your UNIQUE/PK differs (e.g., composite), adjust ON CONFLICT target below.
 */
async function upsertFeinMeta({
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
  const pool = getPool();

  const seasonInt   = toInt(season);
  const platformStr = toStr(platform) || 'espn';
  const sportStr    = toStr(sport) || 'ffl';
  const leagueStr   = toStr(league_id);
  const teamStr     = toStr(team_id);
  const nameStr     = toStr(name);
  const handleStr   = toStr(handle);
  const sizeInt     = toInt(league_size);
  const groupsStr   = toStr(fb_groups);

  if (!seasonInt || !leagueStr || !teamStr) {
    throw new Error('missing season/league_id/team_id');
  }

  // Canonical 21-digit (or similar) id from your codec
  const id = createId({ platform: platformStr, season: seasonInt, leagueId: leagueStr, teamId: teamStr });
  const updated_at = new Date().toISOString();

  const sql = `
    INSERT INTO fein_meta (
      id, platform, sport, season, league_id, team_id,
      name, handle, league_size, fb_groups, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id)
    DO UPDATE SET
      platform    = EXCLUDED.platform,
      sport       = EXCLUDED.sport,
      season      = EXCLUDED.season,
      league_id   = EXCLUDED.league_id,
      team_id     = EXCLUDED.team_id,
      name        = COALESCE(EXCLUDED.name, fein_meta.name),
      handle      = COALESCE(EXCLUDED.handle, fein_meta.handle),
      league_size = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
      fb_groups   = COALESCE(EXCLUDED.fb_groups, fein_meta.fb_groups),
      updated_at  = EXCLUDED.updated_at
    RETURNING
      id, platform, sport, season, league_id, team_id,
      name, handle, league_size, fb_groups, updated_at
  `;

  const params = [
    id, platformStr, sportStr, seasonInt, leagueStr, teamStr,
    nameStr, handleStr, sizeInt, groupsStr, updated_at,
  ];

  const { rows } = await pool.query(sql, params);
  return rows[0];
}

/** Fetch a specific row by its natural key. */
async function getFeinMetaByKey({ season, platform = 'espn', league_id, team_id }) {
  const pool = getPool();

  const seasonInt   = toInt(season);
  const platformStr = toStr(platform) || 'espn';
  const leagueStr   = toStr(league_id);
  const teamStr     = toStr(team_id);

  if (!seasonInt || !leagueStr || !teamStr) {
    throw new Error('missing season/league_id/team_id');
  }

  const sql = `
    SELECT id, season, platform, sport, league_id, team_id,
           name, handle, league_size, fb_groups, updated_at
    FROM ff_sport_ffl
    WHERE season = $1 AND platform = $2 AND league_id = $3 AND team_id = $4
    LIMIT 1
  `;
  const params = [seasonInt, platformStr, leagueStr, teamStr];
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

/* ------------------------------- HTTP routes ------------------------------- */

/**
 * POST /api/fein-auth/fein/meta/upsert
 * Body: season, platform?, sport?, league_id, team_id, name?, handle?, league_size?, fb_groups?
 * Reads cookies if you later need them, but they are not required here.
 */
router.post('/fein/meta/upsert', async (req, res) => {
  try {
    // If you later tie rows to members, derive user_id here from auth/session:
    // const user_id = req.user?.id || null;
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

    const meta = await upsertFeinMeta({
      season,
      platform,
      sport,
      league_id,
      team_id,
      name,
      handle,
      league_size,
      fb_groups,
    });

    return res.status(200).json({ ok: true, meta });
  } catch (e) {
    console.error('[fein-meta upsert] error:', e);
    const msg = String(e?.message || e);
    const code = /missing season\/league_id\/team_id/i.test(msg) ? 400 : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
});

/** Optional GET for debugging:
 *  GET /api/fein-auth/fein/meta?season=2025&platform=espn&league_id=1888700373&team_id=4
 */
router.get('/fein/meta', async (req, res) => {
  try {
    const { season, platform = 'espn', league_id, team_id } = req.query || {};
    const meta = await getFeinMetaByKey({ season, platform, league_id, team_id });
    return res.json({ ok: true, meta });
  } catch (e) {
    const msg = String(e?.message || e);
    const code = /missing season\/league_id\/team_id/i.test(msg) ? 400 : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
});

module.exports = router;
