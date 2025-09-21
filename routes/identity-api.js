// TRUE_LOCATION: routes/identity-api.js
// IN_USE: TRUE
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../src/db/pool'); // adjust path if your pool lives elsewhere

const router = express.Router();
router.use(express.json());

/* ----- health (optional) ----- */
router.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_error', message: e.message });
  }
});

/* ----- id normalize ----- */
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

/* ----- tiny rate limit ----- */
const recent = new Map();
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
// Add this helper near the top of the file
function randomColorHex() {
  // curated palette: bold, neutral, sporty; no pinks/purples
  const palette = [
    '#1F77B4', // strong blue
    '#2CA02C', // green
    '#D62728', // red
    //'#9467BD', // deep violet (optional: comment this if you want no purple at all)
    '#8C564B', // brown
    //'#E377C2', // pinkish (REMOVE if not allowed)
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
  // filter out pinks/purples if you want to be strict:
  const filtered = palette.filter(c =>
    !c.includes('C2') && !c.includes('BD')
  );
  const arr = filtered.length ? filtered : palette;
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ----- bootstrap table for logging requests ----- */
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

/* ----- LEGACY-SAFE 8-char code (fits CHAR(8)) ----- */
function makeInteractedCode8() {
  // no ambiguous chars; exactly 8 chars
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out; // e.g. 7KX94Q2N
}

/* ----- member helpers ----- */
async function findOrCreateMember(kind, value) {
  const col = (kind === 'email') ? 'email' : (kind === 'phone') ? 'phone_e164' : 'username';

  // Try to find existing
  const f = await pool.query(`SELECT * FROM ff_member WHERE ${col} = $1 LIMIT 1`, [value]);
  if (f.rows[0]) {
    // Backfill 8-char interacted_code if missing (CHAR(8) safe)
if (f.rows[0]) {
  // Backfill interacted_code if missing
  if (!f.rows[0].interacted_code) {
    const interacted = makeInteractedCode8();
    const upd = await pool.query(
      `UPDATE ff_member
         SET interacted_code = $1,
             last_seen_at     = now()
       WHERE member_id = $2
       RETURNING *`,
      [interacted, f.rows[0].member_id]
    );
    return upd.rows[0];
  }

  // 🔥 Backfill color_hex if missing
  if (!f.rows[0].color_hex) {
    const upd = await pool.query(
      `UPDATE ff_member
         SET color_hex = $1,
             last_seen_at = now()
       WHERE member_id = $2
       RETURNING *`,
      [randomColorHex(), f.rows[0].member_id]
    );
    return upd.rows[0];
  }

  return f.rows[0];
}


  // Create minimal new member with interacted_code (NOT NULL, CHAR(8))
  const interacted = makeInteractedCode8();
// Create minimal new member with color_hex and timestamps
const ins = await pool.query(
  `INSERT INTO ff_member (${col}, color_hex, first_seen_at, last_seen_at)
   VALUES ($1, $2, now(), now())
   RETURNING *`,
  [value, randomColorHex()]
);
return ins.rows[0];
}
}
function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ----- NOOP sender (keeps 200s even without creds) ----- */
async function sendCode({ identifierKind, identifierValue, code }) {
  const mailReady = !!(process.env.SENDGRID_API_KEY || process.env.SMTP_HOST);
  const smsReady = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  if (identifierKind === 'email' && !mailReady) {
    console.log(`[MAIL:NOOP] ${identifierValue} code=${code}`);
    return;
  }
  if (identifierKind === 'phone' && !smsReady) {
    console.log(`[SMS:NOOP] ${identifierValue} code=${code}`);
    return;
  }
  // hook up nodemailer / twilio as desired
}

/* ----- POST /api/identity/request-code ----- */
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

    const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const rl = ratelimit(`${ipHash}:${value}`, 6, 60_000);
    if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

    await ensureRequestsTable();
    await pool.query(
      `INSERT INTO ff_identity_requests (identifier_kind, identifier_value, ip_hash) VALUES ($1,$2,$3)`,
      [kind, value, ipHash]
    );

    const member = await findOrCreateMember(kind, value);

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

    await sendCode({ identifierKind: kind, identifierValue: value, code });

    // IMPORTANT: return signup_url so the client navigates
    const u = new URL('/signup', 'https://fortifiedfantasy.com');
    if (kind === 'email')  u.searchParams.set('email', value);
    if (kind === 'phone')  u.searchParams.set('phone', value);
    if (kind === 'handle') u.searchParams.set('handle', value);

    return res.status(200).json({
      ok: true,
      sent: true,
      member_id: member.member_id,
      signup_url: u.pathname + u.search,
      ms: Date.now() - start,
    });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
