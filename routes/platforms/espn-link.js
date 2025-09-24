// routes/platforms/espn-link.js
const express = require('express');
const { pool } = require('../../server'); // adjust path if needed

const router = express.Router();
router.use(express.json());

function readCookiesHeader(header = '') {
  const out = {};
  (header || '').split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}
function normalizeSwid(raw = '') {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.startsWith('{') ? v.toUpperCase() : `{${v.replace(/[{}]/g,'').toUpperCase()}}`;
}

// POST /api/platforms/espn/link-via-cookie
// Reads SWID/S2 from cookies/headers, finds ff_quickhitter.quick_snap, sets ff_member cookie.
router.post('/link-via-cookie', async (req, res) => {
  try {
    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swidH = req.get('x-espn-swid') || '';
    const s2H   = req.get('x-espn-s2')   || '';
    const swidC = cookies.SWID || cookies.ff_espn_swid || '';
    const s2C   = cookies.espn_s2 || cookies.ff_espn_s2 || '';

    const swid = normalizeSwid(swidH || swidC);
    const s2   = decodeURIComponent((s2H || s2C || '').trim());

    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });

    // find a quickhitter with matching quick_snap
    const q = await pool.query(
      `SELECT * FROM ff_quickhitter WHERE LOWER(quick_snap)=LOWER($1) LIMIT 1`,
      [swid]
    );
    const row = q.rows[0];
    if (!row) return res.status(404).json({ ok:false, error:'no_quickhitter_for_swid' });

    // set ff_member so /quickhitter/check can see session
    res.cookie('ff_member', row.member_id, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });

    // (optional) upsert S2 into ff_espn_cred for this SWID
    if (s2) {
      await pool.query(`
        INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
        VALUES ($1, $2, encode(digest($1,'sha256'),'hex'), encode(digest($2,'sha256'),'hex'), NOW(), NOW())
        ON CONFLICT (swid) DO UPDATE
          SET espn_s2=EXCLUDED.espn_s2, s2_hash=EXCLUDED.s2_hash, last_seen=NOW()
      `, [swid, s2]);
    }

    return res.json({ ok:true, member_id: row.member_id, handle: row.handle, quick_snap: row.quick_snap });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
