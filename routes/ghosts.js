const express = require('express');
const pool = require('../src/db/pool');
const { normalizeSwid } = require('../lib/espn');

const router = express.Router();

router.post('/add', async (req,res) => {
  const sid = req.cookies?.ff_sid || null;
  if (!sid) return res.status(401).json({ ok:false, error:'not_authenticated' });

  const { swid } = req.body || {};
  const sw = normalizeSwid(swid);
  if (!sw) return res.status(422).json({ ok:false, error:'bad_swID' });

  // Resolve session → member
  const s = await pool.query(`SELECT member_id FROM ff_session WHERE session_id=$1`, [sid]);
  if (!s.rowCount) return res.status(401).json({ ok:false, error:'bad_session' });
  const memberId = s.rows[0].member_id;

  // Don’t allow stealing an existing SWID
  const owned = await pool.query(`SELECT member_id FROM ff_quickhitter WHERE quick_snap=$1 LIMIT 1`, [`{${sw}}`]);
  if (owned.rowCount && owned.rows[0].member_id !== memberId) {
    return res.status(409).json({ ok:false, error:'swid_primary_elsewhere' });
  }
  const owned2 = await pool.query(`SELECT member_id FROM ff_member_ghost_swid WHERE swid=$1`, [sw]);
  if (owned2.rowCount && owned2.rows[0].member_id !== memberId) {
    return res.status(409).json({ ok:false, error:'swid_ghost_elsewhere' });
  }

  await pool.query(
    `INSERT INTO ff_member_ghost_swid (member_id, swid)
     VALUES ($1,$2)
     ON CONFLICT (member_id, swid) DO NOTHING`,
    [memberId, sw]
  );

  res.json({ ok:true, added:true, swid: sw });
});

module.exports = router;
