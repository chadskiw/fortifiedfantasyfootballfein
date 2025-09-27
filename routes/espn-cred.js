const express = require('express');
const pool = require('../src/db/pool');
const router = express.Router();

router.use(express.json());

// GET /api/platforms/espn/cred  → simple status check
router.get('/', async (req, res) => {
  try {
    const h = req.headers || {};
    const c = req.cookies || {};
    const swid = h['x-espn-swid'] || c.SWID || c.swid || req.query.swid || '';
    const s2   = h['x-espn-s2']   || c.ESPN_S2 || c.espn_s2 || req.query.s2   || '';

    // If you want to reflect DB state, try lookup by swid
    if (swid) {
      const r = await pool.query('SELECT swid FROM ff_espn_cred WHERE swid = $1', [swid]);
      const found = r.rowCount > 0;
      return res.json({ ok: true, step: found ? 'logged_in' : 'link_needed' });
    }
    // Fallback: if cookies present, assume linked
    if (swid && s2) return res.json({ ok: true, step: 'logged_in' });
    return res.json({ ok: true, step: 'link_needed' });
  } catch (e) {
    console.error('[cred GET]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/platforms/espn/cred  → upsert (was /cred/upsert)
router.post('/', async (req, res) => {
  try {
    const swid = String(req.body?.swid || '').trim();
    const s2   = String(req.body?.s2   || req.body?.espn_s2 || '').trim();
    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });

    // requires pgcrypto installed once:
    // CREATE EXTENSION IF NOT EXISTS pgcrypto;
    await pool.query(`
      INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
      VALUES ($1, NULLIF($2,''), encode(digest($1,'sha256'),'hex'), NULLIF(encode(digest($2,'sha256'),'hex'),''), NOW(), NOW())
      ON CONFLICT (swid) DO UPDATE
        SET espn_s2   = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
            s2_hash   = COALESCE(EXCLUDED.s2_hash, ff_espn_cred.s2_hash),
            last_seen = NOW()
    `, [swid, s2]);

    res.json({ ok:true });
  } catch (e) {
    console.error('[cred upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/platforms/espn/cred/assign-ref  → set ref once
router.post('/assign-ref', async (req, res) => {
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
    console.error('[cred assign-ref]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
