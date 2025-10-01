// routes/platforms/espn.js
const express = require('express');
const db = require('../../src/db/pool');
const pool = db.pool || db;
if (!pool?.query) throw new Error('[platforms/espn] pg pool missing');

const sessionRouter = require('../session'); // for createSession + cookie
const router = express.Router();
router.use(express.json({ limit:'1mb' }));

async function ensureTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_espn_cred (
      swid        TEXT PRIMARY KEY,     -- "{...}"
      s2          TEXT,
      member_id   TEXT,                 -- linked member if claimed
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- quickhitter gets a 'quick_snap' (ESPN swid) if you want to store owner hint there
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ff_quickhitter' AND column_name='quick_snap') THEN
        ALTER TABLE ff_quickhitter ADD COLUMN quick_snap TEXT;
        CREATE INDEX IF NOT EXISTS ff_quickhitter_quicksnap_idx ON ff_quickhitter(quick_snap);
      END IF;
    END $$;
  `);
}
function readSwid(req){
  const h = req.headers||{};
  const c = req.cookies||{};
  return (
    h['x-espn-swid'] || c.ff_espn_swid || c.SWID || c.swid ||
    (req.query?.swid) || null
  );
}
function readS2(req){
  const h = req.headers||{};
  const c = req.cookies||{};
  return (
    h['x-espn-s2'] || c.ff_espn_s2 || c.espn_s2 || c.ESPN_S2 ||
    (req.query?.s2) || null
  );
}

// GET /api/platforms/espn/authcheck  → { ok:true, authed:boolean }
router.get('/authcheck', async (req,res) => {
  try {
    const swid = readSwid(req);
    const s2   = readS2(req);
    res.set('Cache-Control','no-store');
    return res.json({ ok:true, authed: !!(swid && s2) });
  } catch(e){ res.status(500).json({ ok:false, error:'internal_error' }); }
});

// POST /api/platforms/espn/link-via-cookie
// Uses SWID/S2 from cookies/headers, upserts ff_espn_cred, links to existing quickhitter.quick_snap if present,
// and creates a session for that member.
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


// POST /api/platforms/espn/lookup { swid, s2 }
// Peer to your client “Claim team” bootstrap. Returns a minimal member-like object if we can infer from quickhitter.
router.post('/lookup', async (req,res) => {
  try {
    await ensureTables();
    const { swid, s2 } = req.body||{};
    if (!swid || !s2) return res.status(422).json({ ok:false, error:'missing_fields' });

    await pool.query(`
      INSERT INTO ff_espn_cred (swid, s2)
      VALUES ($1,$2)
      ON CONFLICT (swid) DO UPDATE SET s2=EXCLUDED.s2, updated_at=NOW()
    `,[swid, s2]);

    const { rows } = await pool.query(`
      SELECT q.member_id, q.handle, q.color_hex, q.email, q.phone, q.avatar_url
        FROM ff_quickhitter q
       WHERE q.quick_snap = $1
       LIMIT 1
    `,[swid]);

    if (!rows[0]) return res.json({ ok:true, member:null });
    return res.json({ ok:true, member: rows[0] });
  } catch(e){ console.error('[espn.lookup]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

module.exports = router;
