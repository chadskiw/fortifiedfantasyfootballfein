// TRUE_LOCATION: routes/identity-api.js
// IN_USE: TRUE
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../src/db/pool');

const router = express.Router();
router.use(express.json());

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */
router.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_error', message: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Identifier normalization                                                   */
/* -------------------------------------------------------------------------- */
const EMAIL_RX  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RX  = /^\+?[0-9\s().-]{7,20}$/;
const HANDLE_RX = /^[a-zA-Z0-9_.]{3,24}$/;

function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: null, value: null };
  if (EMAIL_RX.test(s)) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[^\d+]/g, '');
  if (PHONE_RX.test(s) && (digits.match(/\d/g) || []).length >= 7) {
    return { kind: 'phone', value: digits.startsWith('+') ? digits : `+${digits}` };
  }
  if (HANDLE_RX.test(s)) return { kind: 'handle', value: s };
  return { kind: null, value: null };
}

/* -------------------------------------------------------------------------- */
/* Tiny rate limit                                                            */
/* -------------------------------------------------------------------------- */
const recent = new Map(); // key -> { count, resetAt }
function ratelimit(key, limit = 6, ttlMs = 60_000) {
  const now = Date.now();
  const rec = recent.get(key);
  if (!rec || rec.resetAt <= now) {
    recent.set(key, { count: 1, resetAt: now + ttlMs });
    return { ok: true };
  }
  if (rec.count >= limit) return { ok: false, resetAt: rec.resetAt };
  rec.count += 1;
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Log table bootstrap                                                        */
/* -------------------------------------------------------------------------- */
const CREATE_REQ_SQL = `
  CREATE TABLE IF NOT EXISTS ff_identity_requests (
    id BIGSERIAL PRIMARY KEY,
    identifier_kind  TEXT NOT NULL,
    identifier_value TEXT NOT NULL,
    ip_hash          TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
  )
`;
async function ensureRequestsTable() {
  await pool.query(CREATE_REQ_SQL);
}

/* -------------------------------------------------------------------------- */
/* Member helpers                                                             */
/* -------------------------------------------------------------------------- */
// --- color helpers (respect shape & avoid handle clashes) ---
const HEX_RX = /^#[0-9A-Fa-f]{6}$/;

function hexOK(hex) { return HEX_RX.test(hex); }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgbDist(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr*dr + dg*dg + db*db); // 0..441
}

// curated palette: no pinks/purples, high-contrast
const COLOR_PALETTE = [
  '#1F77B4','#2CA02C','#D62728','#8C564B','#7F7F7F',
  '#BCBD22','#17BECF','#FF7F0E','#0057E7','#008744',
  '#D62D20','#FFA700','#4C4C4C'
];

// Avoid colors “too close” to ones already in use by this handle
async function pickColorForHandle(handle, halo = 48) {
  // Fetch colors already used by this handle (if any)
  const { rows } = await pool.query(
    `SELECT DISTINCT color_hex FROM ff_member WHERE username = $1 AND color_hex IS NOT NULL`,
    [handle]
  );
  const used = rows.map(r => r.color_hex).filter(hexOK).map(hexToRgb);

  // First, try palette colors that pass the halo distance
  const candidates = COLOR_PALETTE.filter(hexOK);
  for (const c of candidates) {
    const rgb = hexToRgb(c);
    if (!used.length || used.every(u => rgbDist(u, rgb) >= halo)) return c;
  }
  // No safe color available → signal to skip writing color
  return null;
}

// For non-handle flows, keep the quick random (but shape-valid)
function randomColorHexSafe() {
  const c = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
  return hexOK(c) ? c : '#4C4C4C';
}

// Strong, high-contrast, non-pink/purple palette
function randomColorHex() {
  const palette = [
    '#1F77B4', // blue
    '#2CA02C', // green
    '#D62728', // red
    '#8C564B', // brown
    '#7F7F7F', // grey
    '#BCBD22', // olive
    '#17BECF', // teal
    '#FF7F0E', // orange
    '#0057E7', // royal blue
    '#008744', // dark green
    '#D62D20', // fire red
    '#FFA700', // bright orange
    '#4C4C4C'  // charcoal
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

// 8-char confusion-free ID (A-Z except I/O; digits 2-9)
async function generateUniqueMemberId(pool) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeId() {
    let out = '';
    for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
  // Try until unique (fast with proper index/PK)
  // Assumes ff_member.member_id is CHAR(8)/TEXT PRIMARY KEY or UNIQUE
  // If not yet changed, you can still store it in a separate column/cookie.
  // Here we just ensure uniqueness before insert.
  for (;;) {
    const candidate = makeId();
    const { rowCount } = await pool.query(
      'SELECT 1 FROM ff_member WHERE member_id = $1 LIMIT 1',
      [candidate]
    );
    if (rowCount === 0) return candidate;
  }
}

/**
 * Find a member by identifier or create a new row with:
 * - member_id: 8-char unique code
 * - color_hex: random from sporty palette
 * Also backfills color_hex if missing for existing members.
 */
async function findOrCreateMember(kind, value) {
  const col = (kind === 'email') ? 'email'
           : (kind === 'phone') ? 'phone_e164'
           : 'username';

  // Find existing
  const f = await pool.query(`SELECT * FROM ff_member WHERE ${col} = $1 LIMIT 1`, [value]);
if (f.rows[0]) {
  let row = f.rows[0];

  // Backfill color if missing
  if (!row.color_hex) {
    let color = null;
    if (kind === 'handle') {
      color = await pickColorForHandle(value); // may be null (no safe color)
    } else {
      color = randomColorHexSafe();
    }
    if (color) {
      const upd = await pool.query(
        `UPDATE ff_member
            SET color_hex   = $1,
                last_seen_at = now()
          WHERE member_id   = $2
          RETURNING *`,
        [color, row.member_id]
      );
      row = upd.rows[0];
    }
  }
  return row;
}


  // Create new
const memberId = await generateUniqueMemberId(pool);

let color = null;
if (kind === 'handle') {
  color = await pickColorForHandle(value); // may be null (skip if no safe)
} else {
  color = randomColorHexSafe();
}

let ins;
if (color) {
  ins = await pool.query(
    `INSERT INTO ff_member (member_id, ${col}, color_hex, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now())
     RETURNING *`,
    [memberId, value, color]
  );
} else {
  // No safe color available → do not write color_hex (let it be NULL)
  ins = await pool.query(
    `INSERT INTO ff_member (member_id, ${col}, first_seen_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     RETURNING *`,
    [memberId, value]
  );
}
return ins.rows[0];

}

/* -------------------------------------------------------------------------- */
/* Code sender (NOOP until creds provided)                                    */
/* -------------------------------------------------------------------------- */
function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

async function sendCode({ identifierKind, identifierValue, code }) {
  const mailReady = !!(process.env.SENDGRID_API_KEY || process.env.SMTP_HOST);
  const smsReady  = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

  try {
    if (identifierKind === 'email') {
      if (!mailReady) {
        console.log(`[MAIL:NOOP] ${identifierValue} code=${code}`);
        return;
      }
      const nodemailer = require('nodemailer');
      let transporter;
      if (process.env.SENDGRID_API_KEY) {
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
      return;
    }

    if (identifierKind === 'phone') {
      if (!smsReady) {
        console.log(`[SMS:NOOP] ${identifierValue} code=${code}`);
        return;
      }
      const twilio = require('twilio')(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      await twilio.messages.create({
        to: identifierValue,
        from: process.env.TWILIO_FROM,
        body: `Fortified Fantasy code: ${code}`,
      });
      return;
    }
  } catch (e) {
    console.warn('[sendCode] failed:', e?.message || e);
  }
}

/* -------------------------------------------------------------------------- */
/* POST /api/identity/request-code                                            */
/* -------------------------------------------------------------------------- */
router.post('/request-code', async (req, res) => {
  const start = Date.now();
  try {
    const { identifier } = req.body || {};
    const { kind, value } = normalizeIdentifier(identifier);

    if (!value) {
      return res.status(422).json({
        ok: false,
        error: 'invalid_identifier',
        message: 'Provide a valid email, E.164 phone, or handle.',
      });
    }

    // Rate limit
    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const rl = ratelimit(`${ipHash}:${value}`, 6, 60_000);
    if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

    // Log request
    await ensureRequestsTable();
    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash)
       VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    // Ensure member row
    const member = await findOrCreateMember(kind, value);
    if (!member || !member.member_id) {
      // Defensive guard — avoid "cannot read properties of undefined (member_id)"
      throw new Error('member_creation_failed');
    }

    // Create login code
    const code = makeCode();
    const exp  = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE ff_member
          SET login_code         = $1,
              login_code_expires = $2,
              last_seen_at       = now()
        WHERE member_id = $3`,
      [code, exp, member.member_id]
    );

    // Fire-and-forget send (never blocks redirect)
    sendCode({ identifierKind: kind, identifierValue: value, code }).catch(() => {});

    // Set the key cookie (member_id is your canonical code)
    res.cookie('ff_member', member.member_id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year
    });

    // Client expects signup_url to proceed
    const u = new URL('/signup', 'https://fortifiedfantasy.com');
    if (kind === 'email')  u.searchParams.set('email', value);
    if (kind === 'phone')  u.searchParams.set('phone', value);
    if (kind === 'handle') u.searchParams.set('handle', value);

    return res.status(200).json({
      ok: true,
      sent: true,
      member_id: member.member_id,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
