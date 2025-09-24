// routes/platforms/espn-link.js
const express = require('express');
const pool = require('../../src/db/pool');

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

// GET /api/platforms/espn/authcheck  → { ok:true, authed:boolean }
router.get('/authcheck', (req, res) => {
  const cookies = readCookiesHeader(req.headers.cookie || '');
  const swid = normalizeSwid(req.get('x-espn-swid') || cookies.SWID || cookies.ff_espn_swid || '');
  const s2   = (req.get('x-espn-s2') || cookies.espn_s2 || cookies.ff_espn_s2 || '').trim();
  res.json({ ok:true, authed: !!(swid || s2) });
});

// POST /api/platforms/espn/link-via-cookie
// - Reads SWID/S2 from headers/cookies
// - Finds matching ff_quickhitter.quick_snap
// - Sets ff_member cookie
// - Upserts ff_espn_cred with s2 (if present)
router.post('/link-via-cookie', async (req, res) => {
  try {
    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swid = normalizeSwid(req.get('x-espn-swid') || cookies.SWID || cookies.ff_espn_swid || '');
    const s2   = decodeURIComponent((req.get('x-espn-s2') || cookies.espn_s2 || cookies.ff_espn_s2 || '').trim());

    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });

    // Find quickhitter by quick_snap (case-insensitive)
    const qh = await pool.query(
      `SELECT member_id, handle, quick_snap FROM ff_quickhitter WHERE LOWER(quick_snap)=LOWER($1) LIMIT 1`,
      [swid]
    );
    const row = qh.rows[0];
    if (!row) return res.status(404).json({ ok:false, error:'no_quickhitter_for_swid' });

    // Set session cookie
    res.cookie('ff_member', row.member_id, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });

    // Upsert s2 so we remember it (optional but requested)
    if (s2) {
      await pool.query(`
        INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
        VALUES ($1, $2, encode(digest($1,'sha256'),'hex'), encode(digest($2,'sha256'),'hex'), NOW(), NOW())
        ON CONFLICT (swid) DO UPDATE
          SET espn_s2=EXCLUDED.espn_s2, s2_hash=EXCLUDED.s2_hash, last_seen=NOW()
      `, [swid, s2]);
    }

    res.json({ ok:true, member_id: row.member_id, handle: row.handle, quick_snap: row.quick_snap });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
