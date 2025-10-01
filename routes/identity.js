// src/routes/identity.js
const express = require('express');
const router  = express.Router();
router.use(express.json());
// ==== OPAQUE OPTION + CHALLENGE STATE (use Redis in prod) ====
const crypto = require('crypto');
const mem = {
  options: new Map(),    // option_id -> { member_id, kind:'email'|'phone', identifier, exp }
  challenges: new Map(), // challenge_id -> { member_id, identifier, channel, code_hash, exp }
};
const TTL_OPTION_MS = 10 * 60 * 1000;   // 10m
const TTL_CHALLENGE_MS = 5 * 60 * 1000; // 5m

const rid = (p)=> `${p}_${crypto.randomBytes(16).toString('hex')}`;
const sha = (s)=> crypto.createHash('sha256').update(String(s)).digest('hex');
const nowMs = ()=> Date.now();
const expMs = (ms)=> nowMs() + ms;

function maskEmail(e){ const [u,d]=String(e).split('@'); return d ? `${u.slice(0,2)}…@${d}` : e; }
function maskPhone(p){ const t=String(p).replace(/[^\d]/g,''); return t.length>=4 ? `••• ••${t.slice(-4)}` : p; }

let db = require('../src/db/pool'); // adjust path to your pool
let pool = db.pool || db;

const { sendVerification, ensureE164, EMAIL_RE } = require('../services/notify');

// ---------- helpers ----------
const now = () => new Date();
const addMinutes = (d, m) => new Date(d.getTime() + m*60000);
const norm = v => String(v || '').trim();
function getMemberId(req){
  return (req.cookies && String(req.cookies.ff_member || '').trim()) || null;
}
// routes/identity/resolve.js

// mask helpers (display-only hints)
const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  return d ? `${u.slice(0, 2)}…@${d}` : '';
};
const maskPhone = (p) => {
  const t = String(p || '').replace(/[^\d]/g, '');
  return t.length >= 4 ? `••• ••${t.slice(-4)}` : '';
};

// Accepts handle/email/phone, but we’ll use handle here
const classify = (v) => {
  if (!v) return { kind: 'null' };
  const s = String(v).trim();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  const phone = /^\+?[0-9][0-9\s\-().]{5,}$/.test(s);
  const handle = /^[A-Za-z0-9_.]{3,24}$/.test(s);
  if (email) return { kind: 'email', value: s.toLowerCase() };
  if (phone) {
    let t = s.replace(/[^\d+]/g, '');
    if (t && !t.startsWith('+') && t.length === 10) t = '+1' + t;
    return { kind: 'phone', value: t };
  }
  if (handle) return { kind: 'handle', value: s };
  return { kind: 'bad' };
};

// POST /api/signin/resolve
router.post('/resolve', async (req, res) => {
  try {
    const body = req.body || {};
    // allow either {handle} or {identifier}, prefer handle for chooser
    const input = body.handle ?? body.identifier ?? '';
    const { kind, value } = classify(input);

    // For the chooser UI we only resolve by handle; all other kinds just return empty
    if (kind !== 'handle') {
      return res.json({ ok: true, candidates: [] });
    }

    // server-side lookup — NO PII goes back to client
    // expects you have `pool` (pg) in req.app.locals or global
    const pool = req.app.get('pg'); // set this in server.js: app.set('pg', pool)
    const { rows } = await pool.query(
      `SELECT member_id, handle, color_hex, image_key,
              email, email_is_verified,
              phone, phone_is_verified,
              COALESCE(quick_snap, FALSE) AS quick_snap
         FROM ff_quickhitter
        WHERE LOWER(handle) = LOWER($1)`,
      [value]
    );

    const candidates = rows.map((r) => {
      const opts = [];
      if (r.email && String(r.email_is_verified).toLowerCase().startsWith('t')) {
        opts.push({ kind: 'email', hint: maskEmail(r.email), option_id: null /* fill later via /request-code */ });
      }
      if (r.phone && String(r.phone_is_verified).toLowerCase().startsWith('t')) {
        opts.push({ kind: 'sms', hint: maskPhone(r.phone), option_id: null /* fill later via /request-code */ });
      }
      return {
        display: {
          handle: r.handle,
          color: r.color_hex || '#77E0FF',
          image_key: r.image_key || null,
          espn: !!r.quick_snap,
        },
        // opaque options will be issued per-click by /identity/request-code
        // to avoid ever sending email/phone/member_id to FE
        options: opts,
      };
    });

    return res.json({ ok: true, candidates });
  } catch (e) {
    console.error('[signin/resolve] error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});



// ---------- POST /api/identity/request-code ----------
// PATCH to existing route: POST /api/identity/request-code
router.post('/request-code', async (req, res) => {
  try{
    const member_id = getMemberId(req) || null;

    // NEW: opaque option path
    const option_id = norm(req.body?.option_id);
    if (option_id) {
      const opt = mem.options.get(option_id);
      if (!opt || opt.exp < nowMs()) return res.status(400).json({ ok:false, error:'option_expired' });

      const code = ('' + Math.floor(100000 + Math.random()*900000)).slice(-6);
      const challenge_id = rid('ch');
      mem.challenges.set(challenge_id, {
        member_id: opt.member_id,
        identifier: opt.identifier,
        channel: opt.kind === 'email' ? 'email' : 'sms',
        code_hash: sha(code),
        exp: expMs(TTL_CHALLENGE_MS)
      });

      // send using your existing service
      const sent = await sendVerification({ identifier: opt.identifier, code, expiresMin:5 });
      if (!sent.ok) {
        return res.status(202).json({ ok:false, error:'delivery_unavailable', reason: sent.reason });
      }
      return res.json({ ok:true, channel: sent.channel, challenge_id });
    }

    // OLD path (keep working): raw identifier
    const raw = norm(req.body?.identifier);
    if (!raw) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const isEmail = EMAIL_RE.test(raw);
    const phoneE164 = ensureE164(raw);
    const identifier = isEmail ? raw.toLowerCase() : (phoneE164 || null);
    if (!identifier) return res.status(422).json({ ok:false, error:'bad_identifier', message:'Enter a valid email or E.164 phone.' });

    // Create and stage code as you already do…
    const code = ('' + Math.floor(100000 + Math.random()*900000)).slice(-6);
    const expiresAt = addMinutes(now(), 10);

    await pool.query(`
      INSERT INTO ff_identity_code (member_id, identifier, channel, code, attempts, expires_at)
      VALUES ($1, $2, $3, $4, 0, $5)
      ON CONFLICT (identifier) DO UPDATE SET
        member_id  = EXCLUDED.member_id,
        channel    = EXCLUDED.channel,
        code       = EXCLUDED.code,
        attempts   = 0,
        expires_at = EXCLUDED.expires_at
    `, [member_id || 'ANON', identifier, isEmail ? 'email' : 'sms', code, expiresAt]);

    const sent = await sendVerification({ identifier, code, expiresMin:10 });
    if (!sent.ok) {
      return res.status(202).json({ ok:false, error:'delivery_unavailable', reason: sent.reason });
    }
    return res.json({ ok:true, channel: sent.channel });

  }catch(e){
    console.error('[identity.request-code] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


// ---------- POST /api/identity/verify ----------
// PATCH to existing route: POST /api/identity/verify
router.post('/verify', async (req, res) => {
  try{
    const ch = norm(req.body?.challenge_id);
    const code = norm(req.body?.code);

    if (ch) {
      const row = mem.challenges.get(ch);
      if (!row || row.exp < nowMs()) return res.status(410).json({ ok:false, error:'challenge_expired' });
      if (sha(code) !== row.code_hash) return res.status(401).json({ ok:false, error:'code_mismatch' });

      // mark verified in quickhitter
      if (row.channel === 'email') {
        await pool.query(`
          UPDATE ff_quickhitter
             SET email = COALESCE($1, email),
                 email_is_verified = TRUE,
                 updated_at = now()
           WHERE member_id = $2 OR LOWER(email) = LOWER($1)
        `,[row.identifier, row.member_id]);
      } else {
        await pool.query(`
          UPDATE ff_quickhitter
             SET phone = COALESCE($1, phone),
                 phone_is_verified = TRUE,
                 updated_at = now()
           WHERE member_id = $2 OR phone = $1
        `,[row.identifier, row.member_id]);
      }

      mem.challenges.delete(ch);
      return res.json({ ok:true, verified:true, channel: row.channel });
    }

    // OLD path (identifier + code) — unchanged from your current implementation
    const rawId = norm(req.body?.identifier);
    if (!rawId || !code) return res.status(400).json({ ok:false, error:'bad_request' });

    const isEmail = EMAIL_RE.test(rawId);
    const phoneE164 = ensureE164(rawId);
    const identifier = isEmail ? rawId.toLowerCase() : (phoneE164 || null);
    if (!identifier) return res.status(422).json({ ok:false, error:'bad_identifier' });

    const { rows } = await pool.query(`
      SELECT id, member_id, channel, code, attempts, expires_at
      FROM ff_identity_code
      WHERE identifier=$1
      LIMIT 1
    `, [identifier]);
    const r = rows[0];
    if (!r) return res.status(404).json({ ok:false, error:'code_not_found' });
    if (now() > new Date(r.expires_at)) return res.status(410).json({ ok:false, error:'code_expired' });
    if (r.code !== code) {
      await pool.query(`UPDATE ff_identity_code SET attempts = attempts + 1 WHERE id=$1`, [r.id]);
      return res.status(401).json({ ok:false, error:'code_mismatch' });
    }

    if (isEmail) {
      await pool.query(`
        UPDATE ff_quickhitter
           SET email = COALESCE($1, email),
               email_is_verified = TRUE,
               updated_at = now()
         WHERE COALESCE(member_id,'') <> ''
           AND (LOWER(email)=LOWER($1) OR member_id = $2)
      `,[identifier, r.member_id]);
    } else {
      await pool.query(`
        UPDATE ff_quickhitter
           SET phone = COALESCE($1, phone),
               phone_is_verified = TRUE,
               updated_at = now()
         WHERE COALESCE(member_id,'') <> ''
           AND (phone=$1 OR member_id = $2)
      `,[identifier, r.member_id]);
    }

    await pool.query(`DELETE FROM ff_identity_code WHERE id=$1`, [r.id]);
    return res.json({ ok:true, verified:true, channel: r.channel });

  }catch(e){
    console.error('[identity.verify] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


module.exports = router;
