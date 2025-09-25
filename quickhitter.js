// src/routes/identity/quickhitter.js
// Endpoints mounted at /api/identity
// - GET  /handle/exists?u=<handle>
// - POST /handle/upsert  { handle }
// - POST /qh-upsert      { handle?, email?, phone?, hex?, avatarDataUrl? }
// - POST /avatar         { avatarDataUrl }  -> returns { url }
//
// Also sets an httpOnly, signed flow cookie "ff_flow" to mark progress.
// Avatar upload supports RS/S3 via env; falls back to local tmp if not configured.
//Added sharp npm i sharp @aws-sdk/client-s3

const express = require('express');
const crypto  = require('crypto');
const sharp   = require('sharp');

// Works with default or named export
let pool = require('../db/pool');
if (pool && pool.pool && typeof pool.pool.query === 'function') pool = pool.pool;
if (!pool || typeof pool.query !== 'function') throw new Error('[qh] pool missing');

const { putAvatarFromDataUrl } = require('../../lib/rs');

const router = express.Router();
router.use(express.json({ limit: '5mb' }));
router.use(express.urlencoded({ extended: false }));

/* ---------------------- validation + utils ---------------------- */

const HANDLE_RE = /^[a-zA-Z0-9_.](?:[a-zA-Z0-9_. ]{1,22})[a-zA-Z0-9_.]$/; // allow internal single spaces, no ends
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HEX_RE    = /^#?[0-9a-f]{6}$/i;

const normHandle = h => {
  const raw = String(h || '').trim().replace(/\s{2,}/g, ' ');
  return HANDLE_RE.test(raw) ? raw : null;
};
const normEmail  = e => EMAIL_RE.test(String(e||'').trim()) ? String(e).trim().toLowerCase() : null;
const normPhone  = p => {
  const s = String(p||'').trim(); if (!PHONE_RE.test(s)) return null;
  const digits = s.replace(/[^\d]/g, '');
  return digits.length === 10 ? `+1${digits}` :
         digits.length === 11 && digits.startsWith('1') ? `+${digits}` : `+${digits}`;
};
const normHex    = h => {
  const s = String(h||'').trim().replace(/^#/,'');
  return HEX_RE.test(s) ? `#${s.toUpperCase()}` : null;
};

async function ensureTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_quickhitter (
      member_id   TEXT,
      handle      TEXT,
      email       TEXT,
      phone       TEXT,
      color_hex   TEXT,
      avatar_url  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ff_quickhitter_handle_idx ON ff_quickhitter(LOWER(handle));
    CREATE INDEX IF NOT EXISTS ff_quickhitter_email_idx  ON ff_quickhitter(LOWER(email));
    CREATE INDEX IF NOT EXISTS ff_quickhitter_phone_idx  ON ff_quickhitter(phone);
    CREATE INDEX IF NOT EXISTS ff_quickhitter_member_idx ON ff_quickhitter(member_id);

    CREATE TABLE IF NOT EXISTS ff_member (
      member_id        TEXT PRIMARY KEY,
      username         TEXT,
      email            TEXT,
      phone_e164       TEXT,
      color_hex        TEXT,
      login_code       TEXT,
      login_code_expires TIMESTAMPTZ,
      first_seen_at    TIMESTAMPTZ,
      last_seen_at     TIMESTAMPTZ,
      event_count      INT,
      email_verified_at TIMESTAMPTZ,
      phone_verified_at TIMESTAMPTZ
    );
  `);
}

async function handleExists(h){
  const { rows } = await pool.query(`
    SELECT 1 FROM ff_member WHERE LOWER(username)=LOWER($1) LIMIT 1
  `, [h]);
  if (rows.length) return true;
  const r2 = await pool.query(`
    SELECT 1 FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1) LIMIT 1
  `, [h]);
  return r2.rows.length > 0;
}

async function upsertQuickhitter({ member_id=null, handle=null, email=null, phone=null, hex=null, avatar_url=null }){
  await ensureTables();
  const existing = await pool.query(`
    SELECT member_id, handle, email, phone, color_hex, avatar_url
      FROM ff_quickhitter
     WHERE (LOWER(handle)=LOWER($1) AND $1 IS NOT NULL)
        OR (LOWER(email)=LOWER($2)  AND $2 IS NOT NULL)
        OR (phone=$3               AND $3 IS NOT NULL)
     ORDER BY updated_at DESC
     LIMIT 1
  `, [handle, email, phone]);
  const row = existing.rows[0] || null;

  const next = {
    member_id: member_id || row?.member_id || null,
    handle:    handle    || row?.handle    || null,
    email:     email     || row?.email     || null,
    phone:     phone     || row?.phone     || null,
    color_hex: hex       || row?.color_hex || null,
    avatar_url:avatar_url|| row?.avatar_url|| null,
  };

  await pool.query(`
    INSERT INTO ff_quickhitter (member_id, handle, email, phone, color_hex, avatar_url, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6, NOW())
  `, [next.member_id, next.handle, next.email, next.phone, next.color_hex, next.avatar_url]);

  return next;
}

/* -------------------------- flow cookie -------------------------- */
// httpOnly, HMAC-signed flow marker (not readable from JS)
const FLOW_COOKIE = 'ff_flow';
const FLOW_SECRET = process.env.FF_FLOW_SECRET || 'dev-only-not-secret';

function sign(val){
  const mac = crypto.createHmac('sha256', FLOW_SECRET).update(val).digest('base64url');
  return `${val}.${mac}`;
}
function verify(signed){
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const val = signed.slice(0, i);
  const mac = signed.slice(i+1);
  const want = crypto.createHmac('sha256', FLOW_SECRET).update(val).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? val : null;
}
// --- Add near the other helpers ---
async function existsInMemberOrQH({ handle=null, email=null, phone=null }) {
  const out = { handle:false, email:false, phone:false };
  if (handle) {
    const r1 = await pool.query(`SELECT 1 FROM ff_member WHERE LOWER(username)=LOWER($1) LIMIT 1`, [handle]);
    const r2 = await pool.query(`SELECT 1 FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1) LIMIT 1`, [handle]);
    out.handle = !!(r1.rows[0] || r2.rows[0]);
  }
  if (email) {
    const r1 = await pool.query(`SELECT 1 FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    const r2 = await pool.query(`SELECT 1 FROM ff_quickhitter WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    out.email = !!(r1.rows[0] || r2.rows[0]);
  }
  if (phone) {
    const r1 = await pool.query(`SELECT 1 FROM ff_member WHERE phone_e164=$1 LIMIT 1`, [phone]);
    const r2 = await pool.query(`SELECT 1 FROM ff_quickhitter WHERE phone=$1 LIMIT 1`, [phone]);
    out.phone = !!(r1.rows[0] || r2.rows[0]);
  }
  return out;
}

// --- New: /api/identity/status ---
router.get('/status', async (req, res) => {
  try {
    await ensureTables();
    const memberId = req.cookies?.ff_member || null;

    let qh = null;
    if (memberId) {
      const { rows } = await pool.query(`
        SELECT handle, email, phone, color_hex, avatar_url
          FROM ff_quickhitter
         WHERE member_id=$1
         ORDER BY updated_at DESC
         LIMIT 1
      `, [memberId]);
      qh = rows[0] || null;
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      memberId: memberId || null,
      quickhitter: qh || null
    });
  } catch (e) {
    console.error('[identity/status]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// --- New: /api/quickhitter/check (legacy path, but we can mount this router there too) ---
router.get('/check', async (req, res) => {
  try {
    const h = req.query.handle ? normHandle(req.query.handle) : null;
    const e = req.query.email  ? normEmail(req.query.email)   : null;
    const p = req.query.phone  ? normPhone(req.query.phone)   : null;
    if (!h && !e && !p) return res.status(422).json({ ok:false, error:'missing_params' });

    await ensureTables();
    const exists = await existsInMemberOrQH({ handle:h, email:e, phone:p });

    res.json({ ok:true, exists });
  } catch (e) {
    console.error('[quickhitter/check]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

/* ----------------------------- routes ---------------------------- */

// GET /api/identity/handle/exists?u=foo
router.get('/handle/exists', async (req,res) => {
  try{
    const u = normHandle(req.query.u);
    if (!u) return res.status(200).json({ ok:true, available:false, reason:'invalid' });
    await ensureTables();
    const taken = await handleExists(u);
    res.json({ ok:true, available: !taken, handle:u });
  } catch(e){
    console.error('[handle/exists]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// POST /api/identity/handle/upsert { handle }
router.post('/handle/upsert', async (req,res) => {
  try{
    const body = req.body || {};
    const handle = normHandle(body.handle);
    if (!handle) return res.status(422).json({ ok:false, error:'invalid_handle' });
    await ensureTables();
    const taken = await handleExists(handle);
    if (taken) return res.status(409).json({ ok:false, error:'handle_taken' });

    // Prefer updating ff_member.username if we have a member cookie
    const memberId = req.cookies?.ff_member || null;
    if (memberId){
      await pool.query(`
        UPDATE ff_member
           SET username=$1, last_seen_at=NOW()
         WHERE member_id=$2
      `, [handle, memberId]);
    }
    await upsertQuickhitter({ member_id: memberId, handle });

    // mark flow step
    res.cookie(FLOW_COOKIE, sign('signup:handle'), { httpOnly:true, sameSite:'Lax', secure:process.env.NODE_ENV==='production', path:'/' });

    res.json({ ok:true, handle });
  } catch(e){
    console.error('[handle/upsert]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// POST /api/identity/qh-upsert  (handle/email/phone/hex/avatarDataUrl)
router.post('/qh-upsert', async (req,res) => {
  try{
    const b = req.body || {};
    const memberId = req.cookies?.ff_member || null;
    const handle = b.handle ? normHandle(b.handle) : null;
    const email  = b.email  ? normEmail(b.email)   : null;
    const phone  = b.phone  ? normPhone(b.phone)   : null;
    const hex    = b.hex    ? normHex(b.hex)       : null;

    if (!handle && !email && !phone) {
      return res.status(422).json({ ok:false, error:'nothing_to_upsert' });
    }

    // avatar upload if provided
    let avatarUrl = null;
    if (b.avatarDataUrl && String(b.avatarDataUrl).startsWith('data:')){
      // resize to square ~256px jpg
      const out = await sharp(Buffer.from(b.avatarDataUrl.split(',')[1], 'base64'))
        .resize(256, 256, { fit:'cover' })
        .jpeg({ quality:78 })
        .toBuffer();
      avatarUrl = await putAvatarFromDataUrl({ bytes: out, memberId: memberId || 'anon', contentType:'image/jpeg' });
    }

    const rec = await upsertQuickhitter({ member_id:memberId, handle, email, phone, hex, avatar_url: avatarUrl || undefined });

    // mirror into ff_member when possible
    if (memberId){
      await pool.query(`
        UPDATE ff_member
           SET username = COALESCE($1, username),
               email    = COALESCE($2, email),
               phone_e164 = COALESCE($3, phone_e164),
               color_hex= COALESCE($4, color_hex),
               last_seen_at = NOW()
         WHERE member_id = $5
      `, [handle, email, phone, hex, memberId]);
    }

    // mark flow step
    res.cookie(FLOW_COOKIE, sign('signup:qh'), { httpOnly:true, sameSite:'Lax', secure:process.env.NODE_ENV==='production', path:'/' });

    res.json({ ok:true, record: rec, avatar_url: avatarUrl || rec.avatar_url || null });
  } catch(e){
    console.error('[qh-upsert]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

// POST /api/identity/avatar { avatarDataUrl }
router.post('/avatar', async (req,res) => {
  try{
    const memberId = req.cookies?.ff_member || 'anon';
    const dataUrl = String(req.body?.avatarDataUrl || '');
    if (!dataUrl.startsWith('data:')) return res.status(422).json({ ok:false, error:'invalid_data_url' });

    const out = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
      .resize(256,256,{fit:'cover'})
      .jpeg({ quality:78 })
      .toBuffer();

    const url = await putAvatarFromDataUrl({ bytes: out, memberId, contentType: 'image/jpeg' });

    await ensureTables();
    await upsertQuickhitter({ member_id: memberId, avatar_url: url });

    res.json({ ok:true, url });
  } catch(e){
    console.error('[avatar]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
