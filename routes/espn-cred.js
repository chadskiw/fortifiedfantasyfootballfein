// routes/espn-cred.js
const express = require('express');
const pool = require('../src/db/pool');
const router = express.Router();

router.use(express.json());

router.post('/cred/upsert', async (req, res) => {
  try {
    const swid = String(req.body?.swid || '').trim();
    const s2   = String(req.body?.s2   || req.body?.espn_s2 || '').trim();
    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });

    await pool.query(`
      INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
      VALUES ($1, NULLIF($2,''), encode(digest($1,'sha256'),'hex'), NULLIF(encode(digest($2,'sha256'),'hex'),''), NOW(), NOW())
      ON CONFLICT (swid) DO UPDATE
        SET espn_s2  = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
            s2_hash  = COALESCE(EXCLUDED.s2_hash, ff_espn_cred.s2_hash),
            last_seen= NOW()
    `, [swid, s2]);

    res.json({ ok:true });
  } catch (e) {
    console.error('[cred/upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

router.post('/cred/assign-ref', async (req, res) => {
  try {
    const swid = String(req.body?.swid || '').trim();
    const ref  = String(req.body?.ref  || '').trim();
    if (!swid || !ref) return res.status(400).json({ ok:false, error:'missing_params' });

    const r = await pool.query(
      `UPDATE ff_espn_cred SET ref=$2 WHERE swid=$1 AND ref IS NULL`,
      [swid, ref]
    );
    if (!r.rowCount) return res.status(409).json({ ok:false, error:'ref_already_set' });
    res.json({ ok:true, ref });
  } catch (e) {
    if (String(e.code) === '23505') return res.status(409).json({ ok:false, error:'ref_taken' });
    console.error('[cred/assign-ref]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
