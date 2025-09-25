// routes/identity/verify-code.js
const express = require('express');
const router = express.Router();
const { pool } = require('../../src/db/pool');
const { checkAndConsumeCode } = require('../../lib/otp');

router.post('/verify-code', async (req, res) => {
  try {
    const { member_id, code, kind } = req.body || {};
    if (!member_id || !code) return res.status(400).json({ ok:false, error:'bad_request' });

    const ok = await checkAndConsumeCode({ memberId: member_id, code: String(code).trim() });
    if (!ok) return res.status(400).json({ ok:false, error:'invalid_or_expired' });

    // Flip verified flags in BOTH tables when possible
    if (kind === 'email') {
      await pool.query(`UPDATE ff_member SET email_verified_at=NOW() WHERE member_id=$1`, [member_id]);
      await pool.query(`UPDATE ff_quickhitter SET email_is_verified=true, updated_at=NOW() WHERE member_id=$1`, [member_id]);
    } else if (kind === 'phone') {
      await pool.query(`UPDATE ff_member SET phone_verified_at=NOW() WHERE member_id=$1`, [member_id]);
      await pool.query(`UPDATE ff_quickhitter SET phone_is_verified=true, updated_at=NOW() WHERE member_id=$1`, [member_id]);
    }

    // create/refresh session here if you have a session module
    // await sessionRouter.createSession(member_id, req, 30);

    res.json({ ok:true });
  } catch (e) {
    console.error('[identity.verify-code]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
