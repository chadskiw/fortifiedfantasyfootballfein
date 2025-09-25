// src/routes/quickhitter.js
const express = require('express');
const router  = express.Router();

const pool = require('../db/pool'); // <-- your pool.js at repo root
if (!pool?.query) throw new Error('[quickhitter] pg pool missing');

router.use(express.json({ limit: '1mb' }));

/* ---------- helpers ---------- */

async function ensureTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_quickhitter (
      member_id TEXT PRIMARY KEY,
      handle TEXT,
      email TEXT,
      phone TEXT,
      color_hex TEXT,
      image_key TEXT,
      avatar_url TEXT,
      email_is_verified BOOLEAN,
      phone_is_verified BOOLEAN,
      adj1 TEXT,
      adj2 TEXT,
      noun TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ff_quickhitter_handle_idx ON ff_quickhitter (LOWER(handle));
    CREATE INDEX IF NOT EXISTS ff_quickhitter_email_idx  ON ff_quickhitter (LOWER(email));
    CREATE INDEX IF NOT EXISTS ff_quickhitter_phone_idx  ON ff_quickhitter (phone);
  `);
}

const RS_PUBLIC = (process.env.RS_PUBLIC_BASE || '').replace(/\/$/,'');
function pubUrlFromKey(key){
  if (!key) return null;
  return RS_PUBLIC ? `${RS_PUBLIC}/${String(key).replace(/^\/+/,'')}` : null;
}

/* ---------- existence check ---------- */
/* GET /api/quickhitter/exists?handle=foo | ?email=bar | ?phone=+1555... */
router.get('/exists', async (req, res) => {
  try{
    await ensureTables();
    const { handle, email, phone } = req.query || {};
    let where = '1=0', val=null, kind='unknown';

    if (handle) { where = 'LOWER(handle) = LOWER($1)'; val = String(handle); kind='handle'; }
    if (email)  { where = 'LOWER(email)  = LOWER($1)'; val = String(email);  kind='email'; }
    if (phone)  { where = 'phone = $1';                val = String(phone);  kind='phone'; }

    if (!val) return res.status(422).json({ ok:false, error:'missing_query' });

    const { rows } = await pool.query(
      `SELECT q.member_id, q.email_is_verified, q.phone_is_verified,
              m.email_verified_at, m.phone_verified_at
         FROM ff_quickhitter q
    LEFT JOIN ff_member m ON m.member_id = q.member_id
        WHERE ${where}
        LIMIT 12`, [val]
    );

    const exists = rows.length > 0;
    let verified = false;
    if (exists && kind !== 'handle') {
      if (kind === 'email') verified = !!(rows[0].email_is_verified || rows[0].email_verified_at);
      if (kind === 'phone') verified = !!(rows[0].phone_is_verified || rows[0].phone_verified_at);
    }

    res.json({ ok:true, exists, verified, count: rows.length });
  }catch(e){
    console.error('[qh.exists]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

/* ---------- candidate list ---------- */
/* GET /api/quickhitter/lookup?handle=foo | ?email=bar | ?phone=+1555... */
router.get('/lookup', async (req, res) => {
  try{
    await ensureTables();
    const { handle, email, phone } = req.query || {};
    let where = '1=0', val=null;

    if (handle) { where = 'LOWER(handle) = LOWER($1)'; val = String(handle); }
    if (email)  { where = 'LOWER(email)  = LOWER($1)'; val = String(email);  }
    if (phone)  { where = 'phone = $1';                val = String(phone);  }

    if (!val) return res.status(422).json({ ok:false, error:'missing_query' });

    const { rows } = await pool.query(`
      SELECT q.member_id, q.handle, q.color_hex, q.image_key, q.avatar_url,
             q.email, q.phone, q.adj1, q.adj2, q.noun,
             m.email_verified_at, m.phone_verified_at
        FROM ff_quickhitter q
   LEFT JOIN ff_member m ON m.member_id = q.member_id
       WHERE ${where}
       ORDER BY q.updated_at DESC
       LIMIT 24
    `, [val]);

    const candidates = rows.map(r => ({
      member_id: r.member_id,
      handle: r.handle,
      color_hex: r.color_hex || '#77e0ff',
      avatar_url: r.avatar_url || pubUrlFromKey(r.image_key) || null,
      image_key: r.image_key || null,
      email: r.email || null,
      phone: r.phone || null,
      has_descriptors: !!(r.adj1 || r.adj2 || r.noun),
      verified_email: !!r.email_verified_at,
      verified_phone: !!r.phone_verified_at
    }));

    res.json({ ok:true, candidates });
  }catch(e){
    console.error('[qh.lookup]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

/* ---------- handle variants for chooser ---------- */
/* GET /api/quickhitter/handle/:handle  → list existing color variants */
router.get('/handle/:handle', async (req, res) => {
  try{
    await ensureTables();
    const h = String(req.params.handle || '');
    const { rows } = await pool.query(`
      SELECT member_id, handle, color_hex, image_key, avatar_url
        FROM ff_quickhitter
       WHERE LOWER(handle) = LOWER($1)
       ORDER BY updated_at DESC
       LIMIT 32
    `, [h]);
    res.json({
      ok:true,
      items: rows.map(r => ({
        member_id: r.member_id,
        handle: r.handle,
        color_hex: r.color_hex || '#77e0ff',
        avatar_url: r.avatar_url || pubUrlFromKey(r.image_key) || null,
        image_key: r.image_key || null
      }))
    });
  }catch(e){
    console.error('[qh.handle]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
