// routes/identity/profile-upsert.js
const express = require('express');
const { pool } = require('../../src/db/pool');
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
function cookieMemberId(req){ return String(req.cookies?.ff_member||'').trim() || null; }
const HEX=/^#?[0-9a-f]{6}$/i;

router.post('/profile/upsert', async (req, res) => {
  try{
    const me = cookieMemberId(req);
    if (!me) return res.status(401).json({ ok:false, error:'unauthorized' });

    const handle = String(req.body?.handle||'').trim() || null;
    let hex = String(req.body?.hex||'').trim();
    hex = HEX.test(hex) ? (hex.startsWith('#')?hex.toUpperCase():('#'+hex.toUpperCase())) : null;

    // update only provided fields; do not overwrite email/phone here
    const r = await pool.query(
      `UPDATE ff_member
          SET username     = COALESCE($1, username),
              color_hex    = COALESCE($2, color_hex),
              last_seen_at = now()
        WHERE member_id = $3
        RETURNING member_id, username, color_hex`,
      [handle, hex, me]
    );

    if (!r.rows[0]) return res.status(404).json({ ok:false, error:'not_found' });
    res.json({ ok:true, member:r.rows[0], updated:true });
  }catch(e){
    console.error('[profile/upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
