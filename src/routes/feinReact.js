// TRUE_LOCATION: src/routes/feinReact.js
// IN_USE: FALSE
// routes/fein-react.js
// FEIN Reactions with dynamic table resolution + debug metadata.
// Mount under /api/fein.

const express = require('express');
const { query } = require('../src/db');
const { readAuthFromRequest } = require('../auth');

const router = express.Router();

const ok   = (res, data) => res.json({ ok: true, ...data });
const bad  = (res, msg)  => res.status(400).json({ ok: false, error: msg || 'Bad request' });
const boom = (res, err)  => res.status(500).json({ ok: false, error: String(err?.message || err) });

const s = v => (v == null ? '' : String(v));
const b = v => (v === true || v === 'true' || v === 1 || v === '1');
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// ----------------------------------------------------------------------------
// DB helpers: detect which table names exist (underscores vs legacy hyphens)
// ----------------------------------------------------------------------------
let TABLES = null; // { totals, user }
let DBMETA  = { db:null, schema:null };

async function loadDbMeta() {
  const r = await query(`SELECT current_database() AS db, current_schema() AS schema`).then(r => r.rows[0]||{});
  DBMETA.db = r.db || null;
  DBMETA.schema = r.schema || null;
}

async function resolveTables() {
  if (TABLES) return TABLES;

  await loadDbMeta();

  // Look for both variants
  const row = await query(`
    SELECT
      to_regclass('public.fein_reaction_totals')            AS u_totals,
      to_regclass('public."fein-reaction-totals"')          AS h_totals,
      to_regclass('public.fein_reaction_user')              AS u_user,
      to_regclass('public."fein-reaction-user"')            AS h_user
  `).then(r => r.rows[0]||{});

  const totals =
    row.u_totals ? 'fein_reaction_totals' :
    row.h_totals ? `"fein-reaction-totals"` : // quoted legacy name
    'fein_reaction_totals'; // default to underscore if none exist

  const user =
    row.u_user ? 'fein_reaction_user' :
    row.h_user ? `"fein-reaction-user"` :
    'fein_reaction_user';

  TABLES = { totals, user };

  // If neither exists, create the underscore versions (preferred)
  if (!row.u_totals && !row.h_totals) {
    await query(`
      CREATE TABLE IF NOT EXISTS fein_reaction_totals (
        entity_key  TEXT PRIMARY KEY,
        fire        INTEGER NOT NULL DEFAULT 0,
        fish        INTEGER NOT NULL DEFAULT 0,
        trash       INTEGER NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  if (!row.u_user && !row.h_user) {
    await query(`
      CREATE TABLE IF NOT EXISTS fein_reaction_user (
        entity_key  TEXT NOT NULL,
        uid         TEXT NOT NULL,
        fish        BOOLEAN NOT NULL DEFAULT FALSE,
        trash       BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (entity_key, uid)
      );
    `);
  }

  return TABLES;
}

function stampHeaders(res){
  if (DBMETA.db)     res.setHeader('X-Fein-DB', DBMETA.db);
  if (DBMETA.schema) res.setHeader('X-Fein-Schema', DBMETA.schema);
  if (TABLES) {
    res.setHeader('X-Fein-Totals', TABLES.totals);
    res.setHeader('X-Fein-User',   TABLES.user);
  }
}

// ----------------------------------------------------------------------------
// Auth helper: get a stable uid (ESPN SWID) for per-user toggles
// ----------------------------------------------------------------------------
function readUID(req){
  const a = (readAuthFromRequest?.(req)) || {};
  if (a?.swid) return String(a.swid);
  const h = s(req.headers['x-uid']).trim();
  if (h) return h;
  const raw = s(req.headers.cookie || '');
  const m = raw.match(/(?:^|;\s*)SWID=([^;]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return '';
}

// ----------------------------------------------------------------------------
// GET /api/fein/react?ekey=...
// ----------------------------------------------------------------------------
router.get('/react', async (req, res) => {
  try {
    await resolveTables();
    stampHeaders(res);

    const ekey = s(req.query.ekey || req.query.entity_key).trim();
    if (!ekey) return bad(res, 'ekey required');

    const sql = `SELECT fire, fish, trash FROM ${TABLES.totals} WHERE entity_key = $1`;
    const row = await query(sql, [ekey]).then(r => r.rows[0]);

    const counts = row ? {
      fire: Number(row.fire||0),
      fish: Number(row.fish||0),
      trash: Number(row.trash||0)
    } : { fire:0, fish:0, trash:0 };

    return ok(res, { counts });
  } catch (e) { return boom(res, e); }
});
// --- helpers for list endpoint ---
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const encCur = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const decCur = (c) => { try { return JSON.parse(Buffer.from(String(c||''), 'base64').toString('utf8')); } catch { return null; } };

// Build an entity_key prefix from high-level filters (kind/season/leagueId/etc)
function buildPrefix({ kind, season, leagueId, teamId, playerId, nflAbbr }) {
  if (kind === 'team') {
    if (season && leagueId && teamId) return `fflteam:${season}:${leagueId}:${teamId}`;
    if (season && leagueId)          return `fflteam:${season}:${leagueId}:`;
    if (season)                      return `fflteam:${season}:`;
    return `fflteam:`;
  }
  if (kind === 'league') {
    if (season && leagueId) return `fflleague:${season}:${leagueId}`;
    if (season)             return `fflleague:${season}:`;
    return `fflleague:`;
  }
  if (kind === 'player') {
    if (playerId) return `fflplayer:${playerId}`;
    return `fflplayer:`;
  }
  if (kind === 'pro') {
    if (nflAbbr) return `nflteam:${String(nflAbbr).toUpperCase()}`;
    return `nflteam:`;
  }
  return ''; // no kind -> no prefix constraint
}

// GET /api/fein/react/list
router.get('/react/list', async (req, res) => {
  try {
    await resolveTables();
    stampHeaders(res);

    const kind       = String(req.query.kind || '').trim().toLowerCase(); // team|league|player|pro
    const season     = String(req.query.season || '').trim();
    const leagueId   = String(req.query.leagueId || '').trim();
    const teamId     = String(req.query.teamId || '').trim();
    const playerId   = String(req.query.playerId || '').trim();
    const nflAbbr    = String(req.query.nflAbbr || '').trim();
    const ekeyPrefix = String(req.query.ekey_prefix || '').trim();
    const type       = String(req.query.type || '').trim().toLowerCase(); // fire|fish|trash
    const minTotal   = Number.isFinite(Number(req.query.min_total)) ? Number(req.query.min_total) : 0;
    const updatedAfter = String(req.query.updated_after || '').trim(); // ISO ts or date
    const search     = String(req.query.search || '').trim(); // substring on entity_key

    // sorting
    const sort = String(req.query.sort || 'updated').trim().toLowerCase(); // updated|fire|fish|trash|total
    const dir  = String(req.query.dir || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = clamp(parseInt(req.query.limit,10) || 500, 1, 1000);

    // cursor (keyset pagination: order by updated_at DESC/ASC + entity_key ASC)
    const cursor = decCur(req.query.cursor);
    const orderUpdated = (sort === 'updated');
    const sortCol = (sort === 'fire' || sort === 'fish' || sort === 'trash') ? sort
                  : (sort === 'total') ? 'total'
                  : 'updated_at';

    const where = [];
    const params = [];
    let pi = 1;

    // prefix logic
    const computedPrefix = ekeyPrefix || buildPrefix({ kind, season, leagueId, teamId, playerId, nflAbbr });
    if (computedPrefix) {
      // exact match if the prefix is a full key (no trailing colon) and matches known shapes
      if (/^(fflteam:\d+:\d+:\d+|fflleague:\d+:\d+|fflplayer:\d+|nflteam:[A-Z]{2,3})$/.test(computedPrefix)) {
        where.push(`entity_key = $${pi++}`); params.push(computedPrefix);
      } else {
        where.push(`entity_key LIKE $${pi++}`); params.push(`${computedPrefix}%`);
      }
    }

    // type filter (only rows where that counter > 0)
    if (type === 'fire' || type === 'fish' || type === 'trash') {
      where.push(`${type} > 0`);
    }

    // updated_after filter
    if (updatedAfter) {
      where.push(`updated_at > $${pi++}`); params.push(updatedAfter);
    }

    // min_total filter
    if (minTotal > 0) {
      where.push(`(fire + fish + trash) >= $${pi++}`); params.push(minTotal);
    }

    // search substring on entity_key
    if (search) {
      where.push(`entity_key ILIKE $${pi++}`); params.push(`%${search}%`);
    }

    // keyset pagination (respecting the ORDER used below)
    if (cursor && cursor.updated_at && cursor.entity_key) {
      // We always keep entity_key ASC as tiebreaker, so:
      // If dir=DESC on updated_at: (updated_at < cur) OR (updated_at = cur AND entity_key > cur_key)
      // If dir=ASC  on updated_at: (updated_at > cur) OR (updated_at = cur AND entity_key > cur_key)
      if (orderUpdated) {
        const cmp = (dir === 'DESC')
          ? `(updated_at < $${pi} OR (updated_at = $${pi} AND entity_key > $${pi+1}))`
          : `(updated_at > $${pi} OR (updated_at = $${pi} AND entity_key > $${pi+1}))`;
        where.push(cmp);
        params.push(cursor.updated_at, cursor.entity_key);
        pi += 2;
      } else {
        // when sorting by fire/fish/trash/total, fall back to updated_at cursor to keep pagination predictable
        const cmp = (dir === 'DESC')
          ? `(updated_at < $${pi} OR (updated_at = $${pi} AND entity_key > $${pi+1}))`
          : `(updated_at > $${pi} OR (updated_at = $${pi} AND entity_key > $${pi+1}))`;
        where.push(cmp);
        params.push(cursor.updated_at, cursor.entity_key);
        pi += 2;
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // safe ORDER BY (only allow whitelisted columns)
    const orderSql = (() => {
      if (sortCol === 'total') {
        return `ORDER BY (fire + fish + trash) ${dir}, entity_key ASC`;
      }
      if (sortCol === 'fire' || sortCol === 'fish' || sortCol === 'trash') {
        return `ORDER BY ${sortCol} ${dir}, updated_at DESC, entity_key ASC`;
      }
      // default: updated_at
      return `ORDER BY updated_at ${dir}, entity_key ASC`;
    })();

    const sql = `
      SELECT entity_key, fire, fish, trash, updated_at,
             (fire + fish + trash) AS total
      FROM ${TABLES.totals}
      ${whereSql}
      ${orderSql}
      LIMIT ${limit}
    `;

    const rows = await query(sql, params).then(r => r.rows || []);

    let next_cursor = null;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      next_cursor = encCur({ updated_at: last.updated_at, entity_key: last.entity_key });
    }

    return ok(res, {
      count: rows.length,
      next_cursor,
      items: rows
    });
  } catch (e) {
    return boom(res, e);
  }
});

// ----------------------------------------------------------------------------
// POST /api/fein/react { entity_key, type, inc }
// ----------------------------------------------------------------------------
router.post('/react', async (req, res) => {
  try {
    await resolveTables();
    stampHeaders(res);

    const body = req.body || {};
    const ekey = s(body.entity_key || body.ekey).trim();
    const type = s(body.type).trim();        // 'fire' | 'fish' | 'trash'
    const inc  = n(body.inc);                // 0 or 1
    if (!ekey || !type) return bad(res, 'entity_key and type required');

    const uid = readUID(req);
    if (!uid) return res.status(401).json({ ok:false, error:'Unauthorized (no uid/SWID)' });

    // Ensure totals row exists
    await query(`INSERT INTO ${TABLES.totals}(entity_key) VALUES ($1) ON CONFLICT (entity_key) DO NOTHING`, [ekey]);

    let counts = { fire:0, fish:0, trash:0 };
    let userState = { fish:false, trash:false };

    if (type === 'fire') {
      const rows = await query(
        `UPDATE ${TABLES.totals}
            SET fire = GREATEST(0, fire + $2), updated_at = now()
          WHERE entity_key = $1
      RETURNING fire, fish, trash`,
        [ekey, Math.max(0, inc)]
      ).then(r => r.rows);
      counts = rows[0] || counts;

    } else if (type === 'fish' || type === 'trash') {
      // Per-user toggle with atomic delta
      const next = b(inc);
      const sql = `
        WITH cur AS (
          SELECT fish, trash
          FROM ${TABLES.user}
          WHERE entity_key = $1 AND uid = $2
          FOR UPDATE
        ),
        up AS (
          INSERT INTO ${TABLES.user}(entity_key, uid, fish, trash, updated_at)
          VALUES ($1, $2,
                  CASE WHEN $3 = 'fish' THEN $4 ELSE COALESCE((SELECT fish  FROM cur), FALSE) END,
                  CASE WHEN $3 = 'trash' THEN $4 ELSE COALESCE((SELECT trash FROM cur), FALSE) END,
                  now())
          ON CONFLICT (entity_key, uid) DO UPDATE SET
            fish = CASE WHEN $3 = 'fish' THEN $4 ELSE ${TABLES.user}.fish END,
            trash= CASE WHEN $3 = 'trash' THEN $4 ELSE ${TABLES.user}.trash END,
            updated_at = now()
          RETURNING
            COALESCE((SELECT fish  FROM cur), FALSE) AS prev_fish,
            COALESCE((SELECT trash FROM cur), FALSE) AS prev_trash,
            fish, trash
        ),
        delta AS (
          SELECT
            CASE
              WHEN $3 = 'fish'  THEN (CASE WHEN (SELECT fish  FROM up) = (SELECT prev_fish  FROM up) THEN 0 WHEN (SELECT fish  FROM up) THEN 1 ELSE -1 END)
              ELSE 0
            END AS d_fish,
            CASE
              WHEN $3 = 'trash' THEN (CASE WHEN (SELECT trash FROM up) = (SELECT prev_trash FROM up) THEN 0 WHEN (SELECT trash FROM up) THEN 1 ELSE -1 END)
              ELSE 0
            END AS d_trash
        )
        UPDATE ${TABLES.totals} t
           SET fish  = GREATEST(0, t.fish  + (SELECT d_fish  FROM delta)),
               trash = GREATEST(0, t.trash + (SELECT d_trash FROM delta)),
               updated_at = now()
         WHERE t.entity_key = $1
        RETURNING t.fire, t.fish, t.trash,
                  (SELECT fish  FROM up) AS user_fish,
                  (SELECT trash FROM up) AS user_trash
      `;
      const r = await query(sql, [ekey, uid, type, next]).then(r => r.rows[0]);
      counts    = r ? { fire:Number(r.fire||0), fish:Number(r.fish||0), trash:Number(r.trash||0) } : counts;
      userState = r ? { fish: !!r.user_fish, trash: !!r.user_trash } : userState;

    } else {
      return bad(res, 'invalid type');
    }

    return ok(res, { entity_key: ekey, counts, user: userState, uid });
  } catch (e) { return boom(res, e); }
});

// ----------------------------------------------------------------------------
// DEBUG: where are we reading/writing?
// GET /api/fein/react/_where?ekey=...
// ----------------------------------------------------------------------------
router.get('/react/_where', async (req, res) => {
  try {
    await resolveTables();
    stampHeaders(res);

    const ekey = s(req.query.ekey || '').trim();
    const out = { db: DBMETA.db, schema: DBMETA.schema, tables: TABLES };

    if (ekey) {
      const row = await query(`SELECT fire, fish, trash, updated_at FROM ${TABLES.totals} WHERE entity_key = $1`, [ekey]).then(r => r.rows[0]||null);
      out.sample = row || null;
      const uid = readUID(req) || '(none)';
      const ur = await query(`SELECT fish, trash, updated_at FROM ${TABLES.user} WHERE entity_key = $1 AND uid = $2`, [ekey, uid]).then(r => r.rows[0]||null);
      out.user = { uid, row: ur };
    }

    return ok(res, out);
  } catch (e) { return boom(res, e); }
});

module.exports = router;
