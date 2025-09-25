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
// POST /platforms/espn/link-via-cookie
router.post('/platforms/espn/link-via-cookie', async (req, res) => {
  try {
    await ensureTables(); // no-op if already created

    // ---- helpers (inline to keep this file self-contained)
    const readCookies = (hdr='') => Object.fromEntries(
      (hdr || '').split(';').map(s => s.trim()).filter(Boolean).map(p => {
        const i = p.indexOf('=');
        return i === -1 ? [p, ''] : [p.slice(0,i), decodeURIComponent(p.slice(i+1))];
      })
    );
    const normalizeSwid = (s='') => {
      const v = String(s || '').trim().toUpperCase();
      if (!v) return '';
      return v.startsWith('{') ? v : `{${v.replace(/[{}]/g,'')}}`;
    };

    // ---- read inputs (headers win, then first-party cookies)
    const cookies = readCookies(req.headers.cookie || '');
    const rawSwid = req.get('x-espn-swid') || cookies.SWID || cookies.ff_espn_swid || '';
    const rawS2   = req.get('x-espn-s2')   || cookies.espn_s2 || cookies.ESPN_S2 || cookies.ff_espn_s2 || '';

    const swid = normalizeSwid(rawSwid);
    if (!swid) return res.status(400).json({ ok:false, error:'missing_swid' });

    // IMPORTANT: S2 is optional. If present, we store/refresh it once; otherwise we rely on stored creds later.
    const s2 = String(rawS2 || '').trim();

    // ---- if S2 present, upsert cred row quickly (idempotent)
    if (s2) {
      await pool.query(`
        INSERT INTO ff_espn_cred (swid, s2, s2_hash, first_seen, last_seen)
        VALUES ($1, $2, encode(digest($2,'sha256'),'hex'), NOW(), NOW())
        ON CONFLICT (swid) DO UPDATE
          SET s2 = EXCLUDED.s2,
              s2_hash = EXCLUDED.s2_hash,
              last_seen = NOW()
      `, [swid, s2]);
    }

    // ---- try to link to an existing member via quickhitter.quick_snap
    const { rows: qhRows } = await pool.query(
      `SELECT member_id, handle, color_hex, email, phone, image_key
         FROM ff_quickhitter
        WHERE LOWER(quick_snap) = LOWER($1)
        LIMIT 1`,
      [swid]
    );

    let memberId = qhRows[0]?.member_id || null;

    if (memberId) {
      // attach member to cred row (even if no fresh S2 was provided)
      await pool.query(
        `UPDATE ff_espn_cred SET member_id=$2, updated_at=NOW() WHERE swid=$1`,
        [swid, memberId]
      );

      // create a proper application session (30 days shown here)
      const s = await sessionRouter.createSession(memberId, req, 30);
      res.cookie('ff_sid', s.sid, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      // helper cookie (non-HttpOnly) for the client to detect ESPN is linked
      res.cookie('fein_has_espn', '1', {
        httpOnly: false,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      // scrub any first-party mirrors of S2/SWID we might have set earlier
      const kill = (name) => res.cookie(name, '', { maxAge: 0, path: '/', sameSite:'Lax', secure: process.env.NODE_ENV === 'production' });
      ['ff_espn_s2','ff_espn_swid','ff_login','ff_auth'].forEach(kill);

      return res.json({ ok:true, step:'linked', member_id: memberId });
    }

    // Not linked yet: still mark helper cookie so UI can show ESPN-available state.
    res.cookie('fein_has_espn', '1', {
      httpOnly: false,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // scrub first-party mirrors regardless; we don't keep S2 client-side
    const kill = (name) => res.cookie(name, '', { maxAge: 0, path: '/', sameSite:'Lax', secure: process.env.NODE_ENV === 'production' });
    ['ff_espn_s2','ff_espn_swid'].forEach(kill);

    // Return "unlinked" so client can proceed to signup-details (will prefill from quickhitter if present)
    return res.json({ ok:true, step: s2 ? 'unlinked_stored' : 'unlinked', swid });
  } catch (e) {
    console.error('[espn.link-via-cookie]', e);
    return res.status(500).json({ ok:false, error:'internal_error' });
  }
});


module.exports = router;
