// src/routes/session.js
const express = require('express');
const crypto  = require('crypto');

const db = require('../src/db/pool');
const pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') throw new Error('[session] pg pool missing');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

/* ---------------- schema ---------------- */
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_session (
      sid        TEXT PRIMARY KEY,
      member_id  TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip_hash    TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS ff_session_member_idx ON ff_session(member_id);

    -- Ensure ff_member has descriptor + verification columns
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='ff_member' AND column_name='adj1') THEN
        ALTER TABLE ff_member
          ADD COLUMN IF NOT EXISTS adj1 TEXT,
          ADD COLUMN IF NOT EXISTS adj2 TEXT,
          ADD COLUMN IF NOT EXISTS noun TEXT,
          ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
      END IF;
    END$$;
  `);
}

function sid() { return crypto.randomBytes(32).toString('base64url'); }
function ipHash(req) {
  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  return crypto.createHash('sha256').update(ip).digest('hex');
}
function cookieOpts(maxAgeMs) {
  const secure = process.env.NODE_ENV === 'production';
  return { httpOnly:true, sameSite:'Lax', secure, path:'/', maxAge:maxAgeMs };
}

async function createSession(memberId, req, ttlDays=30) {
  await ensureTables();
  const id = sid();
  const exp = new Date(Date.now() + ttlDays*24*60*60*1000);
  await pool.query(
    `INSERT INTO ff_session (sid, member_id, expires_at, ip_hash, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, memberId, exp.toISOString(), ipHash(req), String(req.headers['user-agent']||'').slice(0,400)]
  );
  return { sid:id, expires_at:exp.toISOString() };
}
async function destroySession(id) { if (id) await pool.query(`DELETE FROM ff_session WHERE sid=$1`, [id]); }
async function getSession(id) {
  if (!id) return null;
  const { rows } = await pool.query(`
    SELECT s.sid, s.member_id, s.created_at, s.expires_at,
           m.username, m.email, m.phone_e164, m.color_hex,
           m.adj1, m.adj2, m.noun, m.email_verified_at, m.phone_verified_at
      FROM ff_session s
 LEFT JOIN ff_member m ON m.member_id = s.member_id
     WHERE s.sid=$1 AND s.expires_at > NOW()
     LIMIT 1
  `,[id]);
  return rows[0]||null;
}

/* ---------------- routes ---------------- */

// GET /api/session/whoami
router.get('/whoami', async (req,res) => {
  try {
    const sess = await getSession(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    if (!sess) return res.status(401).json({ ok:false, error:'not_authenticated' });
    return res.json({
      ok:true,
      member:{
        member_id: sess.member_id,
        username:  sess.username || null,
        email:     sess.email || null,
        phone:     sess.phone_e164 || null,
        color_hex: sess.color_hex || null,
        adj1: sess.adj1||null, adj2: sess.adj2||null, noun: sess.noun||null
      },
      session:{ created_at:sess.created_at, expires_at:sess.expires_at }
    });
  } catch(e){ console.error('[whoami]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

// POST /api/session/logout
router.post('/logout', async (req,res) => {
  try { await destroySession(req.cookies?.ff_sid||null); }
  catch(e){ console.warn('[logout]', e.message); }
  finally {
    res.cookie('ff_sid','', cookieOpts(0));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, logged_out:true });
  }
});

// POST /api/session/login-by-descriptors { member_id, adj1, adj2, noun }
router.post('/login-by-descriptors', async (req,res) => {
  try {
    await ensureTables();
    const { member_id, adj1, adj2, noun } = req.body||{};
    if (!member_id || !noun) return res.status(422).json({ ok:false, error:'missing_fields' });
    const { rows } = await pool.query(`
      SELECT member_id FROM ff_member
       WHERE member_id=$1
         AND LOWER(noun)=LOWER($2)
         AND ( (LOWER(adj1)=LOWER($3)) OR (LOWER(adj2)=LOWER($3)) )
       LIMIT 1
    `,[member_id, noun, adj1||adj2||'']);
    if (!rows[0]) return res.status(403).json({ ok:false, error:'descriptor_mismatch' });

    const s = await createSession(member_id, req, 30);
    res.cookie('ff_sid', s.sid, cookieOpts(30*24*60*60*1000));
    return res.json({ ok:true, member_id });
  } catch(e){ console.error('[login-by-descriptors]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

// POST /api/session/validate-cookies { kind:'email'|'phone', value }
router.post('/validate-cookies', async (req,res) => {
  try {
    await ensureTables();
    const { kind, value } = req.body||{};
    if (!kind || !value) return res.status(422).json({ ok:false, error:'missing_fields' });

    // If a valid session already exists for a member that owns this contact, accept silently.
    const sess = await getSession(req.cookies?.ff_sid||null);
    if (sess) {
      const owns = (kind==='email' && sess.email && sess.email.toLowerCase()===String(value).toLowerCase())
                || (kind==='phone' && sess.phone_e164 && sess.phone_e164===String(value));
      if (owns) return res.json({ ok:true, member_id:sess.member_id });
    }

    // Otherwise, only auto-OK if the contact is verified AND we find a single member with it.
    const col = (kind==='email') ? 'email' : 'phone_e164';
    const ver = (kind==='email') ? 'email_verified_at IS NOT NULL' : 'phone_verified_at IS NOT NULL';
    const { rows } = await pool.query(`
      SELECT member_id FROM ff_member
       WHERE ${col} = $1 AND ${ver}
       LIMIT 2
    `,[value]);
    if (rows.length === 1) {
      const s = await createSession(rows[0].member_id, req, 30);
      res.cookie('ff_sid', s.sid, cookieOpts(30*24*60*60*1000));
      return res.json({ ok:true, member_id: rows[0].member_id });
    }
    return res.json({ ok:false }); // fall back to other verification methods
  } catch(e){ console.error('[validate-cookies]', e); res.status(500).json({ ok:false, error:'internal_error' }); }
});

module.exports = router;
