const express = require('express');
const router  = express.Router();
router.use(express.json());

const db = require('../db/pool');               // adjust if needed
const pool = db.pool || db;

const rowToMember = (r) => !r ? null : ({
  member_id: r.member_id,
  handle: r.handle || null,
  color_hex: r.color_hex ? (String(r.color_hex).startsWith('#') ? r.color_hex : ('#' + r.color_hex)) : null,
  image_key: r.image_key || null,
  email: r.email || null,
  phone: r.phone || null,
  email_is_verified: !!r.email_is_verified,
  phone_is_verified: !!r.phone_is_verified,
  quick_snap: r.quick_snap || null,
});

// POST /api/profile/update
// body: arbitrary profile bits (e.g., { display_name, bio, fb_groups: [id,...] })
// We stash them into ff_quickhitter.quick_snap (jsonb) for the current member.
router.post('/update', async (req, res) => {
  try {
    const memberId = req.cookies?.ff_member;
    if (!memberId) return res.status(401).json({ ok:false, error:'no_member' });

    // Only allow a small, explicit subset to flow into quick_snap
    const allowed = {};
    const b = req.body || {};
    for (const k of ['display_name','first','last','bio','fb_groups','links','prefs']) {
      if (b[k] !== undefined) allowed[k] = b[k];
    }
    if (!Object.keys(allowed).length) {
      return res.json({ ok:true, member:null }); // nothing to change
    }

    const sql = `
      UPDATE ff_quickhitter
         SET quick_snap = COALESCE(quick_snap, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
       WHERE member_id = $1
       RETURNING *;
    `;
    const { rows } = await pool.query(sql, [memberId, JSON.stringify(allowed)]);
    if (!rows.length) return res.status(404).json({ ok:false, error:'not_found' });

    return res.json({ ok:true, member: rowToMember(rows[0]) });
  } catch (e) {
    console.error('[profile.update]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
