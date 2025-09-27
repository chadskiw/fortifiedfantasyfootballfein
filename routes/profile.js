// src/routes/profile.js
const express = require('express');
const router  = express.Router();
router.use(express.json());

// ---- DB pool ----
let db = require('../src/db/pool'); // adjust path if your pool lives elsewhere
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[profile] pg pool.query missing');
}

// Small helpers
const norm = v => (v === undefined ? null : v);
function cookieMemberId(req){
  return (req.cookies && String(req.cookies.ff_member || '').trim()) || null;
}

// POST /api/profile/update
// Accepts: display_name?, bio?, avatar image_key? (image_key), color_hex? (text), fb_groups? (array/int[] or array of ids), meta? (object)
// Requires: a valid member_id (cookie), and that member must exist.
router.post('/update', async (req, res) => {
  try{
    const member_id = cookieMemberId(req);
    if (!member_id) {
      return res.status(401).json({ ok:false, error:'not_authenticated' });
    }

    // Ensure member exists
    const exists = await pool.query(
      `SELECT 1 FROM ff_member WHERE member_id=$1 AND deleted_at IS NULL LIMIT 1`,
      [member_id]
    );
    if (!exists.rows[0]) {
      // Don’t try to “promote” quickhitter here — this is a real member profile endpoint.
      return res.status(404).json({ ok:false, error:'member_not_found' });
    }

    // Inputs
    const body = req.body || {};
    const display_name = norm(body.display_name);
    const bio          = norm(body.bio);
    const image_key    = norm(body.image_key);
    const color_hex    = norm(body.color_hex);
    const fb_groups    = body.fb_groups === undefined ? null : body.fb_groups; // expect array
    const meta         = body.meta === undefined ? null : body.meta;           // expect object

    // Build dynamic SQL with proper casts
    const sets = [];
    const params = [];
    let p = 1;

    if (display_name !== null){ sets.push(`display_name = COALESCE($${p++}, display_name)`); params.push(display_name); }
    if (bio !== null)         { sets.push(`bio          = COALESCE($${p++}, bio)`);           params.push(bio); }
    if (image_key !== null)   { sets.push(`image_key    = COALESCE($${p++}, image_key)`);     params.push(image_key); }
    if (color_hex !== null)   { sets.push(`color_hex    = COALESCE($${p++}, color_hex)`);     params.push(String(color_hex).replace(/^#/,'').toUpperCase()); }
    if (fb_groups !== null)   { sets.push(`fb_groups    = COALESCE($${p++}::jsonb, fb_groups)`); params.push(JSON.stringify(fb_groups)); }
    if (meta !== null)        { sets.push(`meta         = COALESCE($${p++}::jsonb, meta)`);      params.push(JSON.stringify(meta)); }

    if (!sets.length){
      return res.json({ ok:true, updated:false });
    }

    const sql = `
      UPDATE ff_member
         SET ${sets.join(', ')},
             updated_at = NOW()
       WHERE member_id = $${p}
       RETURNING member_id, display_name, bio, image_key, color_hex, fb_groups, meta, updated_at
    `;
    params.push(member_id);

    const { rows } = await pool.query(sql, params);
    return res.json({ ok:true, updated:true, member: rows[0] });
  }catch(e){
    console.error('[profile.update] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
