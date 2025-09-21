// routes/identity/request-code.js
// COMPLETE + CONFLICT-CHECKS + FULL ff_identity_requests SCHEMA

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../src/db/pool');

const router = express.Router();
router.use(express.json());

/* --------------------------- identifier detection -------------------------- */
const EMAIL_RX  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RX  = /^\+?[0-9\s().-]{7,20}$/;
const HANDLE_RX = /^[a-zA-Z0-9_.]{3,24}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };
  if (EMAIL_RX.test(s)) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[^\d+]/g, '');
  if (PHONE_RX.test(s) && (digits.match(/\d/g) || []).length >= 7) {
    const e164ish = digits.startsWith('+') ? digits : `+${digits}`;
    return { kind: 'phone', value: e164ish };
  }
  if (HANDLE_RX.test(s)) return { kind: 'handle', value: s };
  return { kind: null, value: null };
}

// When caller sends { kind, value } explicitly
function normalizeByKind(kind, value) {
  const k = String(kind || '').trim().toLowerCase();
  const v = String(value || '').trim();
  if (k === 'email' && EMAIL_RX.test(v)) return { kind: 'email', value: v.toLowerCase() };
  if (k === 'phone') {
    const digits = v.replace(/[^\d+]/g, '');
    const only   = digits.replace(/[^\d]/g, '');
    const e164   = digits.startsWith('+') ? digits : (only.length === 10 ? `+1${only}` : `+${only}`);
    if (/^\+\d{7,15}$/.test(e164)) return { kind: 'phone', value: e164 };
  }
  if (k === 'handle' && HANDLE_RX.test(v)) return { kind: 'handle', value: v };
  return { kind: null, value: null };
}

/* ------------------------------ tiny rate limit --------------------------- */
const recent = new Map(); // key -> { count, resetAt }
function ratelimit(key, limit = 6, ttlMs = 60_000) {
  const now = Date.now();
  const rec = recent.get(key);
  if (!rec || rec.resetAt <= now) {
    recent.set(key, { count: 1, resetAt: now + ttlMs });
    return { ok: true, remaining: limit - 1, resetAt: now + ttlMs };
  }
  if (rec.count >= limit) return { ok: false, remaining: 0, resetAt: rec.resetAt };
  rec.count += 1;
  return { ok: true, remaining: limit - rec.count, resetAt: rec.resetAt };
}

/* ----------------------- ff_identity_requests bootstrap -------------------- */
// Match the fuller schema used by verify flow (code/expires/used/invite_id + indexes)
const CREATE_REQUESTS_SQL = `
  CREATE TABLE IF NOT EXISTS ff_identity_requests (
    id BIGSERIAL PRIMARY KEY,
    identifier_kind  TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    code             TEXT,
    expires_at       TIMESTAMPTZ,
    used_at          TIMESTAMPTZ,
    invite_id        BIGINT,
    ip_hash          TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
  );

  DO $do$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'ff_ir_lookup_idx'
    ) THEN
      CREATE INDEX ff_ir_lookup_idx
        ON ff_identity_requests (identifier_kind, identifier_value, code);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'ff_ir_expires_idx'
    ) THEN
      CREATE INDEX ff_ir_expires_idx
        ON ff_identity_requests (expires_at);
    END IF;
  END
  $do$;
`;
async function ensureRequestsTable() {
  await pool.query(CREATE_REQUESTS_SQL);
}

/* ------------------------------- member helpers --------------------------- */
async function generateUniqueMemberId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  while (true) {
    let id = '';
    for (let i = 0; i < 8; i++) id += alphabet[(Math.random() * alphabet.length) | 0];
    const { rowCount } = await pool.query('SELECT 1 FROM ff_member WHERE member_id=$1 LIMIT 1', [id]);
    if (rowCount === 0) return id;
  }
}

// read the current member from cookie if present
function cookieMemberId(req) {
  return String(req.cookies?.ff_member || '').trim() || null;
}

async function findMemberByEmail(email) {
  const { rows } = await pool.query(
    `SELECT member_id, username FROM ff_member WHERE LOWER(email)=LOWER($1) AND deleted_at IS NULL LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}
async function findMemberByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT member_id, username FROM ff_member WHERE phone_e164=$1 AND deleted_at IS NULL LIMIT 1`,
    [phone]
  );
  return rows[0] || null;
}

function makeRecoveryTripleOnce() {
  const adjs = ['mighty','fearless','electric','legendary','prime','clutch','gritty','steady'];
  const nouns = ['endzone','touchdown','huddle','gridiron','sideline','backfield'];
  const a1 = adjs[(Math.random()*adjs.length)|0];
  let a2 = adjs[(Math.random()*adjs.length)|0];
  if (a2 === a1) a2 = adjs[(Math.random()*adjs.length)|0];
  const n1 = nouns[(Math.random()*nouns.length)|0];
  return { adj1:a1, adj2:a2, noun:n1 };
}
async function makeUniqueRecoveryTriple() {
  for (let i=0;i<20;i++) {
    const t = makeRecoveryTripleOnce();
    const { rowCount } = await pool.query(
      `SELECT 1 FROM ff_member
        WHERE LEAST(adj1,adj2)=LEAST($1,$2)
          AND GREATEST(adj1,adj2)=GREATEST($1,$2)
          AND noun=$3 LIMIT 1`,
      [t.adj1,t.adj2,t.noun]
    );
    if (rowCount === 0) return t;
  }
  return makeRecoveryTripleOnce();
}

// ensure or create a member; also ensure a legacy interacted_code
async function findOrCreateMember(kind, value) {
  const col = (kind === 'email') ? 'email' : (kind === 'phone') ? 'phone_e164' : 'username';
  const f = await pool.query(`SELECT * FROM ff_member WHERE ${col}=$1 LIMIT 1`, [value]);
  if (f.rows[0]) return f.rows[0];

  const member_id = await generateUniqueMemberId();
  const triple = await makeUniqueRecoveryTriple();
  const interacted_code = `${triple.adj1}-${triple.adj2}-${triple.noun}`;
  const ins = await pool.query(
    `INSERT INTO ff_member (member_id, ${col}, interacted_code, adj1, adj2, noun, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())
     RETURNING *`,
    [member_id, value, interacted_code, triple.adj1, triple.adj2, triple.noun]
  );
  return ins.rows[0];
}

/* --------------------------- Notification sender --------------------------- */
let notifInited = false, notifReady = false, notificationapi = null;
function initNotificationAPI() {
  if (notifInited) return notifReady;
  notifInited = true;
  try {
    const clientId = process.env.NOTIFICATIONAPI_CLIENT_ID;
    const clientSecret = process.env.NOTIFICATIONAPI_CLIENT_SECRET;
    if (clientId && clientSecret) {
      notificationapi = require('notificationapi-node-server-sdk').default;
      notificationapi.init(clientId, clientSecret);
      notifReady = true;
      console.log('[notify] SDK initialized');
    } else {
      console.log('[notify] SDK not available; missing env credentials');
    }
  } catch (e) {
    console.log('[notify] SDK not initialized:', e?.message || e);
    notifReady = false;
  }
  return notifReady;
}
async function sendViaNotificationAPI({ identifierKind, identifierValue, code }) {
  try {
    if (!initNotificationAPI()) return false;
    const user = { id: identifierValue };
    if (identifierKind === 'email') user.email = identifierValue;
    if (identifierKind === 'phone') user.phone = identifierValue;
    await notificationapi.send({
      notificationId: process.env.NOTIFICATIONAPI_TEMPLATE_ID || 'login-code',
      user,
      mergeTags: { code }
    });
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e?.message || e);
    return false;
  }
}
async function sendViaFallbackProviders({ identifierKind, identifierValue, code }) {
  try {
    if (identifierKind === 'email') {
      const haveSendgrid = !!process.env.SENDGRID_API_KEY;
      const haveSmtp     = !!process.env.SMTP_HOST;
      if (!haveSendgrid && !haveSmtp) { console.log(`[MAIL:NOOP] to=${identifierValue} code=${code}`); return true; }
      const nodemailer = require('nodemailer');
      let transporter;
      if (haveSendgrid) {
        const sgTransport = require('nodemailer-sendgrid').default;
        transporter = nodemailer.createTransport(sgTransport({ apiKey: process.env.SENDGRID_API_KEY }));
      } else {
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
      }
      await transporter.sendMail({
        from: process.env.MAIL_FROM || 'Fortified Fantasy <no-reply@fortifiedfantasy.com>',
        to: identifierValue,
        subject: 'Your Fortified Fantasy sign-in code',
        text: `Your code is: ${code} (valid for 10 minutes)`,
      });
      return true;
    }
    if (identifierKind === 'phone') {
      const haveTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
      if (!haveTwilio) { console.log(`[SMS:NOOP] to=${identifierValue} code=${code}`); return true; }
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({ to: identifierValue, from: process.env.TWILIO_FROM, body: `Fortified Fantasy code: ${code}` });
      return true;
    }
  } catch (e) {
    console.warn('[fallback send] failed:', e?.message || e);
  }
  return false;
}
async function sendCode({ identifierKind, identifierValue, code }) {
  if (await sendViaNotificationAPI({ identifierKind, identifierValue, code })) return;
  await sendViaFallbackProviders({ identifierKind, identifierValue, code });
}
function makeCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

/* --------------------------------- route ---------------------------------- */
// POST /api/identity/request-code
router.post('/', async (req, res) => {
  const start = Date.now();
  try {
    // Accept {identifier} OR {kind,value}
    let detected = { kind:null, value:null };
    if (req.body?.identifier) {
      detected = normalizeIdentifier(req.body.identifier);
    } else if (req.body?.kind && req.body?.value) {
      detected = normalizeByKind(req.body.kind, req.body.value);
    }
    const { kind, value } = detected;

    if (!value) {
      return res.status(422).json({
        ok:false, error:'invalid_identifier',
        message:'Provide a valid email, E.164 phone, or handle.',
        received: req.body
      });
    }

    // Uniqueness pre-check (email/phone cannot belong to a *different* member)
    const me = cookieMemberId(req);
    if (kind === 'email') {
      const hit = await findMemberByEmail(value);
      if (hit && hit.member_id !== me) {
        return res.status(409).json({
          ok:false, error:'contact_conflict',
          message:'Email already connected to a different account.',
          conflicts:[{ field:'email', member_id: hit.member_id, handle: hit.username || null }]
        });
      }
    }
    if (kind === 'phone') {
      const hit = await findMemberByPhone(value);
      if (hit && hit.member_id !== me) {
        return res.status(409).json({
          ok:false, error:'contact_conflict',
          message:'Phone already connected to a different account.',
          conflicts:[{ field:'phone', member_id: hit.member_id, handle: hit.username || null }]
        });
      }
    }

    // Rate limit
    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const rl = ratelimit(`${ipHash}:${value}`, 6, 60_000);
    if (!rl.ok) return res.status(429).json({ ok:false, error:'rate_limited', resetAt: rl.resetAt });

    // Ensure table exists and log request row
    await ensureRequestsTable();
    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash) VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    // Ensure member exists (or create)
    const member = await findOrCreateMember(kind, value);

    // Create login code + expiry on member (kept on ff_member for your existing flows)
    const code = makeCode();
    const exp  = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE ff_member
          SET login_code=$1, login_code_expires=$2, last_seen_at=now()
        WHERE member_id=$3`,
      [code, exp, member.member_id]
    );

    // Set cookies for handoff
    res.cookie('ff_member', String(member.member_id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 365*24*60*60*1000
    });
    const interacted = member.interacted_code || `${member.adj1}-${member.adj2}-${member.noun}`;
    res.cookie('ff_interacted', interacted, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 365*24*60*60*1000
    });

    // Fire-and-forget send
    sendCode({ identifierKind: kind, identifierValue: value, code }).catch(()=>{});

    // Where the client should go next
    const u = new URL('/signup', 'https://fortifiedfantasy.com');
    if (kind === 'email')  u.searchParams.set('email', value);
    if (kind === 'phone')  u.searchParams.set('phone', value);
    if (kind === 'handle') u.searchParams.set('handle', value);

    return res.status(200).json({
      ok:true,
      sent:true,
      member_id: member.member_id,
      interacted_code: interacted,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
