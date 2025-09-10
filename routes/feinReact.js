// routes/fein-react.js
// Totals + per-user toggle state for FEIN reactions.
// Tables required (DDL below). Mount under /api/fein.

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

// --- read uid (ESPN SWID) from cookies/headers/auth helper
function readUID(req){
  // 1) ../auth may already parse SWID/espn_s2
  const a = (readAuthFromRequest?.(req)) || {};
  if (a?.swid) return String(a.swid);

  // 2) header override (useful for server-to-server)
  const h = s(req.headers['x-uid']).trim();
  if (h) return h;

  // 3) raw cookie parse
  const raw = s(req.headers.cookie || '');
  const m = raw.match(/(?:^|;\s*)SWID=([^;]+)/i);
  if (m) return decodeURIComponent(m[1]);

  return '';
}

// --- ensure tables exist (idempotent; cheap in PG)
async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS fein_reaction_totals (
      entity_key TEXT PRIMARY KEY,
      fire  INTEGER NOT NULL DEFAULT 0,
      fish  INTEGER NOT NULL DEFAULT 0,
      trash INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fein_reaction_user (
      entity_key TEXT NOT NULL,
      uid        TEXT NOT NULL,
      fish       BOOLEAN NOT NULL DEFAULT FALSE,
      trash      BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (entity_key, uid)
    );
  `);
}

// --- GET /api/fein/react?ekey=...
router.get('/react', async (req, res) => {
  try {
    await ensureTables();
    const ekey = s(req.query.ekey || req.query.entity_key).trim();
    if (!ekey) return bad(res, 'ekey required');

    const row = await query(
      `SELECT fire, fish, trash FROM fein_reaction_totals WHERE entity_key = $1`,
      [ekey]
    ).then(r => r.rows[0]);

    const counts = row ? { fire: Number(row.fire||0), fish: Number(row.fish||0), trash: Number(row.trash||0) }
                       : { fire:0, fish:0, trash:0 };

    return ok(res, { counts });
  } catch (e) { return boom(res, e); }
});

// --- POST /api/fein/react  { entity_key, type, inc }
router.post('/react', async (req, res) => {
  try {
    await ensureTables();

    const body = req.body || {};
    const ekey = s(body.entity_key || body.ekey).trim();
    const type = s(body.type).trim();         // 'fire' | 'fish' | 'trash'
    const inc  = n(body.inc);                 // 0 or 1
    if (!ekey || !type) return bad(res, 'entity_key and type required');

    const uid = readUID(req);
    if (!uid) return res.status(401).json({ ok:false, error:'Unauthorized (no uid/SWID)' });

    // 1) Guarantee totals row exists
    await query(`
      INSERT INTO fein_reaction_totals(entity_key) VALUES ($1)
      ON CONFLICT (entity_key) DO NOTHING
    `, [ekey]);

    let counts = { fire:0, fish:0, trash:0 };
    let userState = { fish:false, trash:false };

    if (type === 'fire') {
      // Unlimited increments; no per-user state needed
      const rows = await query(`
        UPDATE fein_reaction_totals
           SET fire = GREATEST(0, fire + $2), updated_at = now()
         WHERE entity_key = $1
       RETURNING fire, fish, trash
      `, [ekey, Math.max(0, inc)]).then(r => r.rows);

      counts = rows[0] || counts;

    } else if (type === 'fish' || type === 'trash') {
      // Per-user toggle. Compute delta atomically and apply to totals.
      // next := inc ? true : false
      const next = b(inc);

      const sql = `
        WITH cur AS (
          SELECT fish, trash
          FROM fein_reaction_user
          WHERE entity_key = $1 AND uid = $2
          FOR UPDATE
        ),
        up AS (
          INSERT INTO fein_reaction_user(entity_key, uid, fish, trash, updated_at)
          VALUES ($1, $2,
                  CASE WHEN $3 = 'fish' THEN $4 ELSE COALESCE((SELECT fish  FROM cur), FALSE) END,
                  CASE WHEN $3 = 'trash' THEN $4 ELSE COALESCE((SELECT trash FROM cur), FALSE) END,
                  now())
          ON CONFLICT (entity_key, uid) DO UPDATE SET
            fish = CASE WHEN $3 = 'fish' THEN $4 ELSE fein_reaction_user.fish END,
            trash= CASE WHEN $3 = 'trash' THEN $4 ELSE fein_reaction_user.trash END,
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
        UPDATE fein_reaction_totals t
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

module.exports = router;
