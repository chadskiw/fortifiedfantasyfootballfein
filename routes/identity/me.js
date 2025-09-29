// src/routes/identity/me.js
// Mount with: app.use('/api/identity/me', require('./src/routes/identity/me'));

const express = require('express');
const router = express.Router();

// ---- DB pool (supports either default or named export) ----
let db;
try {
  // adjust path if your pool lives elsewhere
  db = require('../../src/db/pool');
} catch {
  db = require('../../src/db/pool'); // fallback if your structure differs
}
const pool = (db && (db.pool || db));
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[identity/me] pg pool missing/invalid import');
}

// ---- helpers ----
function getMemberIdFromReq(req) {
  const c = req.cookies || {};
  // Prefer explicit member cookies if you set them
  if (typeof c.ff_member === 'string' && c.ff_member) return c.ff_member;
  if (typeof c.ff_member_id === 'string' && c.ff_member_id) return c.ff_member_id;

  // Optional dev override via header (handy for local testing)
  if (req.headers['x-member-id']) return String(req.headers['x-member-id']);

  // If you map ff_sid -> member_id in a session store, resolve here.
  // const sid = c.ff_sid; // look up by sid if you implement that store.
  return null;
}

// CORS/preflight friendly (optional)
router.options('/', (_req, res) => res.sendStatus(204));

/**
 * GET /api/identity/me
 * Returns a normalized snapshot for the current member.
 * If unauthenticated/unknown, returns `{ ok:true, member_id:null }`.
 */
router.get('/', async (req, res) => {
  try {
    const memberId = getMemberIdFromReq(req);

    if (!memberId) {
      return res.json({ ok: true, member_id: null });
    }

    const { rows } = await pool.query(
      `
      SELECT
        member_id,
        handle,
        color_hex,
        email,
        phone_e164                                     AS phone,
        email_verified_at,
        phone_verified_at,
        image_key,
        event_count,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      FROM ff_member
      WHERE deleted_at IS NULL
        AND member_id = $1
      LIMIT 1
      `,
      [memberId]
    );

    if (!rows.length) {
      return res.json({ ok: true, member_id: null });
    }

    const m = rows[0];

    res.json({
      ok: true,
      member_id: m.member_id,
      handle: m.handle || null,
      color_hex: m.color_hex || null,
      email: m.email || null,
      phone: m.phone || null, // aliased from phone_e164
      email_verified_at: m.email_verified_at || null,
      phone_verified_at: m.phone_verified_at || null,
      // Convenience booleans
      email_verified: !!m.email_verified_at,
      phone_verified: !!m.phone_verified_at,
      image_key: m.image_key || null,
      event_count: m.event_count ?? 0,
      first_seen_at: m.first_seen_at || null,
      last_seen_at: m.last_seen_at || null,
      created_at: m.created_at || null,
      updated_at: m.updated_at || null,
    });
  } catch (err) {
    console.error('[identity/me] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
