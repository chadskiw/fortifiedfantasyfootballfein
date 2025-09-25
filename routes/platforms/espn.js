// src/routes/platforms/espn.js
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
router.post('/link-via-cookie', async (req,res) => {
  try{
    await ensureTables();
    const swid = readSwid(req);
    const s2   = readS2(req);
    if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_cookies' });

    await pool.query(`
      INSERT INTO ff_espn_cred (swid, s2)
      VALUES ($1,$2)
      ON CONFLICT (swid) DO UPDATE SET s2=EXCLUDED.s2, updated_at=NOW()
    `,[swid, s2]);

    // try to find a member via quickhitter.quick_snap or ff_member.phone/email you might map
    const { rows:qh } = await pool.query(`
      SELECT member_id, handle, color_hex, email, phone, avatar_url, image_key
        FROM ff_quickhitter
       WHERE quick_snap = $1
       LIMIT 1
    `,[swid]);
    let memberId = qh[0]?.member_id || null;

    if (memberId) {
      await pool.query(`UPDATE ff_espn_cred SET member_id=$2, updated_at=NOW() WHERE swid=$1`, [swid, memberId]);
      const s = await sessionRouter.createSession(memberId, req, 30);
      res.cookie('ff_sid', s.sid, { httpOnly:true, sameSite:'Lax', secure:(process.env.NODE_ENV==='production'), path:'/', maxAge:30*24*60*60*1000 });
      return res.json({ ok:true, member_id: memberId, step:'linked' });
    }
    // If we can't link yet, just return ok so the client can continue signup flow.
    return res.json({ ok:true, step:'unlinked' });
  }catch(e){
    console.error('[espn.link-via-cookie]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
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
