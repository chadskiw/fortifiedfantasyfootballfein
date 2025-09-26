// routes/identity/avatar.js (or inside your identity router)
const express = require('express');
const pool = require('../../src/db/pool');
const router = express.Router();

router.post('/avatar', async (req, res) => {
  try {
    const memberId = req.cookies?.ff_member;
    const key = (req.body && req.body.key) || '';
    if (!memberId || !key) return res.status(400).json({ ok:false, error:'bad_request' });

    await pool.query(
      `UPDATE ff_quickhitter SET image_key=$2, updated_at=now() WHERE member_id=$1`,
      [memberId, key]
    );

    res.json({ ok:true, image_key: key, public_url: `https://img.fortifiedfantasy.com/${key}` });
  } catch (e) {
    console.error('[identity.avatar]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});
module.exports = router;
