// src/routes/members.js
const express = require('express');
const db = require('../db/pool');
const pool = db.pool || db;
if (!pool?.query) throw new Error('[members] pg pool missing');

const router = express.Router();
router.use(express.json({ limit:'1mb' }));

async function ensureTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_member (
      member_id TEXT PRIMARY KEY,
      username TEXT,
      email TEXT,
      phone_e164 TEXT,
      color_hex TEXT,
      image_key TEXT,
      avatar_url TEXT,
      adj1 TEXT, adj2 TEXT, noun TEXT,
      email_verified_at TIMESTAMPTZ,
      phone_verified_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      event_count INT DEFAULT 0,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ff_member_handle_idx ON ff_member(LOWER(username));
    CREATE INDEX IF NOT EXISTS ff_member_email_idx  ON ff_member(LOWER(email));
    CREATE INDEX IF NOT EXISTS ff_member_phone_idx  ON ff_member(phone_e164);
  `);
}

function normHandle(h){ const s=String(h||'').trim(); if(!s) return null; if(!/^[a-zA-Z0-9_.]{3,24}$/.test(s)) return null; return s; }
function normHex(x){ if (!x) return null; const v=String(x).trim(); const ok=/^#?[0-9a-f]{6}$/i.test(v); return ok ? (v.startsWith('#')?v:('#'+v)).toUpperCase() : null; }
function normEmail(e){ const s=String(e||'').trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null; }
function normPhone(p){ let t=String(p||'').replace(/[^\d+]/g,''); if(t && !t.startsWith('+') && t.length===10) t='+1'+t; return t||null; }

router.get('/lookup', async (req,res) => {
  try {
    await ensureTables();
    const { handle, email, phone } = req.query||{};
    let where='1=0', val=null;
    if (handle) { where='LOWER(username)=LOWER($1)'; val=handle; }
    if (email)  { where='LOWER(email)=LOWER($1)';   val=email; }
    if (phone)  { where='phone_e164=$1';            val=phone; }
    if (!val) return res.status(422).json({ ok:false, error:'missing_query' });

    const { rows } = await pool.query(`
      SELECT member_id, username as handle, color_hex, image_key, avatar_url,
             email, phone_e164 as phone, adj1, adj2, noun,
             email_verified_at, phone_verified_at
        FROM ff_member
       WHERE ${where} AND deleted_at IS NULL
       LIMIT 8
    `,[val]);
    res.json(rows[0] ? rows[0] : {});
  } catch(e){ console.error('[members.lookup]',e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

// Colors used for a handle + palette
router.get('/colors', async (req,res) => {
  try {
    await ensureTables();
    const handle = String(req.query.handle||'').trim();
    if (!handle) return res.status(422).json({ ok:false, error:'missing_handle' });
    const { rows } = await pool.query(
      `SELECT DISTINCT UPPER(color_hex) AS hex FROM ff_member WHERE LOWER(username)=LOWER($1) AND color_hex IS NOT NULL`,
      [handle]
    );
    res.json({ used: rows.map(r=>r.hex), palette: ['#77E0FF','#61D095','#FFD166','#FF6B6B','#A78BFA','#F472B6','#34D399','#F59E0B','#22D3EE','#E879F9'] });
  } catch(e){ console.error('[members.colors]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

// Upsert (claim) minimal member
router.post('/upsert', async (req,res) => {
  try {
    await ensureTables();
    const handle = normHandle(req.body?.handle);
    const color  = normHex(req.body?.color_hex);
    const email  = normEmail(req.body?.email);
    const phone  = normPhone(req.body?.phone_e164);

    if (!handle && !email && !phone) return res.status(422).json({ ok:false, error:'nothing_to_upsert' });

    // Does a member already exist?
    const where = handle ? 'LOWER(username)=LOWER($1)'
                : email  ? 'LOWER(email)=LOWER($1)'
                : 'phone_e164=$1';
    const val   = handle || email || phone;
    const { rows:ex } = await pool.query(`SELECT member_id FROM ff_member WHERE ${where} LIMIT 1`, [val]);

    if (!ex[0]) {
      const id = crypto.randomBytes(6).toString('base64url').replace(/[^0-9A-Za-z]/g,'').slice(0,8).toUpperCase();
      await pool.query(`
        INSERT INTO ff_member (member_id, username, email, phone_e164, color_hex, first_seen_at, last_seen_at, event_count)
        VALUES ($1,$2,$3,$4,$5, NOW(), NOW(), 0)
      `,[id, handle, email, phone, color]);
      return res.json({ ok:true, member_id:id });
    } else {
      const id = ex[0].member_id;
      await pool.query(`
        UPDATE ff_member
           SET username = COALESCE($2, username),
               email    = COALESCE($3, email),
               phone_e164 = COALESCE($4, phone_e164),
               color_hex  = COALESCE($5, color_hex),
               last_seen_at = NOW()
         WHERE member_id = $1
      `,[id, handle, email, phone, color]);
      return res.json({ ok:true, member_id:id });
    }
  } catch(e){ console.error('[members.upsert]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

// Descriptor candidates (for LwD grid)
router.get('/descriptor-candidates', async (req,res) => {
  try {
    await ensureTables();
    const { email, phone } = req.query||{};
    let where='1=0', val=null;
    if (email) where='LOWER(email)=LOWER($1)', val=email;
    if (phone) where='phone_e164=$1', val=phone;
    if (!val) return res.status(422).json({ ok:false, error:'missing_query' });
    const { rows } = await pool.query(`
      SELECT member_id, adj1, adj2, noun
        FROM ff_member
       WHERE ${where} AND adj1 IS NOT NULL AND adj2 IS NOT NULL AND noun IS NOT NULL
       LIMIT 12
    `,[val]);
    res.json(rows);
  } catch(e){ console.error('[members.descriptor-candidates]',e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

module.exports = router;
