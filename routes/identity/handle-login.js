// routes/identity/handle-login.js
// COMPLETE ROUTER: handle existence, login decision, 3-word recovery phrase,
// optional code verify, and mocked cookie-based gate -> /fein or /signup.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../src/db/pool');

const router = express.Router();
router.use(express.json());

/* ------------------------------- tiny utils -------------------------------- */
const EMAIL_RX  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RX  = /^\+?[0-9\s().-]{7,20}$/;
const HANDLE_RX = /^[a-zA-Z0-9_.]{3,24}$/;
const HEX_RX    = /^#[0-9A-Fa-f]{6}$/;

function normHandle(u) {
  const s = String(u || '').trim();
  return HANDLE_RX.test(s) ? s : null;
}
function normalizePhoneMaybe(v){
  if (!v) return null;
  const s = String(v).trim();
  const digits = s.replace(/[^\d+]/g,'');
  if (!/^\+?[0-9]{7,20}$/.test(digits)) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/* ----------------------- mock cookie check / setters ----------------------- */
// Treat these cookies as the "logged-in & verified" gate.
// You can swap to your real cookie/session later.
function hasGoodCookies(req) {
  // Mock: both must be present to skip verification
  return Boolean(req.cookies?.ff_auth === '1' && req.cookies?.ff_team === '1');
}
function setGoodCookies(res, member) {
  // Minimal; adjust expiry & httpOnly as you like.
  res.cookie('ff_member', String(member.member_id), {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false, // keep visible to client if you want
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  res.cookie('ff_auth', '1', {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  res.cookie('ff_team', '1', {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

/* ---------------------- ensure recovery table + indexes -------------------- */
// We avoid altering ff_member now; we persist phrases in a helper table.
const CREATE_RECOVERY_SQL = `
  CREATE TABLE IF NOT EXISTS ff_recovery_token (
    member_id  TEXT PRIMARY KEY REFERENCES ff_member(member_id) ON DELETE CASCADE,
    adj1       TEXT NOT NULL,
    adj2       TEXT NOT NULL,
    noun       TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  -- order-independent uniqueness on adjectives + noun:
  CREATE UNIQUE INDEX IF NOT EXISTS ff_recovery_token_unique_combo
    ON ff_recovery_token (
      LEAST(adj1, adj2),
      GREATEST(adj1, adj2),
      noun
    );
`;
async function ensureRecoveryTable() { await pool.query(CREATE_RECOVERY_SQL); }

/* ------------------------ wordbanks (edit anytime) ------------------------- */
const POSITIVE_ADJ = [
  'mighty','relentless','prime','fearless','electric','unbreakable','fortified','clutch','gritty',
  'sharp','undaunted','precise','steady','bold','locked','laser','dominant','resolute','hungry','unyielding'
];
const FOOTBALL_ADJ = [
  'goal-line','two-minute','blitzing','red-zone','upfield','downfield','no-huddle','smashmouth','sideline','backfield',
  'play-action','zone','man','press','bootleg','pancaking','chip-blocking','ball-hawking','field-general','mauler'
];
const FOOTBALL_NOUN = [
  'captain','anchor','hammer','bulldozer','playmaker','general','torch','engine','bulwark','vanguard',
  'ballhawk','enforcer','finisher','spark','pillar','keystone','ace','charger','streak','sentinel'
];

// deterministic-ish shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (crypto.randomBytes(1)[0] % (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick(arr) { return arr[crypto.randomBytes(2).readUInt16BE() % arr.length]; }

/* ------------------- generate unique adj1,adj2,noun combo ------------------ */
async function ensureRecoveryFor(member_id) {
  await ensureRecoveryTable();

  const existing = await pool.query(
    `SELECT adj1, adj2, noun FROM ff_recovery_token WHERE member_id = $1`,
    [member_id]
  );
  if (existing.rows[0]) return existing.rows[0];

  // Try a few times to avoid hitting the unique index
  for (let attempt = 0; attempt < 25; attempt++) {
    const a1 = pick(POSITIVE_ADJ);
    const a2 = pick(FOOTBALL_ADJ);
    const n  = pick(FOOTBALL_NOUN);
    try {
      const ins = await pool.query(
        `INSERT INTO ff_recovery_token (member_id, adj1, adj2, noun)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (member_id) DO UPDATE SET adj1 = EXCLUDED.adj1, adj2 = EXCLUDED.adj2, noun = EXCLUDED.noun
         RETURNING adj1, adj2, noun`,
        [member_id, a1, a2, n]
      );
      return ins.rows[0];
    } catch (e) {
      // If we tripped the unique combo index, retry
      if (String(e.code) === '23505') continue;
      throw e;
    }
  }
  // Fallback (shouldn't happen)
  return { adj1: 'fortified', adj2: 'red-zone', noun: 'anchor' };
}

/* ------------------ decoy generation for multiple choice ------------------- */
function buildPhrase({ adj1, adj2, noun }) {
  return `${adj1}-${adj2}-${noun}`;
}
function buildDecoys(correct, count = 5) {
  const seen = new Set([correct]);
  const decoys = [];
  const A = shuffle(POSITIVE_ADJ), B = shuffle(FOOTBALL_ADJ), C = shuffle(FOOTBALL_NOUN);
  let ai = 0, bi = 0, ci = 0;

  while (decoys.length < count && (ai < A.length || bi < B.length || ci < C.length)) {
    const a = A[ai++ % A.length], b = B[bi++ % B.length], c = C[ci++ % C.length];
    const s = `${a}-${b}-${c}`;
    if (!seen.has(s)) { seen.add(s); decoys.push(s); }
  }
  return shuffle(decoys.concat(correct));
}

/* ----------------------------- handle existence --------------------------- */
// GET /api/identity/handle/exists?u=
router.get('/handle/exists', async (req, res) => {
  try {
    const u = normHandle(req.query.u);
    if (!u) return res.json({ ok: true, exists: false });
    const r = await pool.query(`SELECT 1 FROM ff_member WHERE username = $1 LIMIT 1`, [u]);
    return res.json({ ok: true, exists: r.rowCount > 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/* ------------------------------ main login path --------------------------- */
// POST /api/identity/handle/login { handle }
router.post('/handle/login', async (req, res) => {
  try {
    const handle = normHandle(req.body?.handle);
    if (!handle) return res.status(422).json({ ok: false, error: 'invalid_handle' });

    const q = await pool.query(`SELECT * FROM ff_member WHERE username = $1 LIMIT 1`, [handle]);

    // Not found -> push to signup with handle prefilled
    if (q.rowCount === 0) {
      const u = new URL('/signup', 'https://fortifiedfantasy.com');
      u.searchParams.set('handle', handle);
      return res.json({
        ok: true,
        next: u.pathname + u.search,
        prefill: { handle }
      });
    }

    const member = q.rows[0];

    // If cookies already indicate OK → go to FEIN
    if (hasGoodCookies(req)) {
      const u = new URL('/fein', 'https://fortifiedfantasy.com');
      u.searchParams.set('season', String(new Date().getUTCFullYear()));
      return res.json({ ok: true, next: u.pathname + u.search });
    }

    // Need verification: offer methods. Code path reuses your /request-code.
    // Phrase path prepares a 3-word selection bank (correct + decoys).
    const token = await ensureRecoveryFor(member.member_id);
    const correct = buildPhrase(token);
    const options = buildDecoys(correct, 7); // total ~8 options

    return res.json({
      ok: true,
      needVerification: true,
      methods: ['code', 'phrase', 'team'], // 'team' = your JS verification
      phrase: { options, correctHint: 'three-word team identity' }, // don't reveal correct
      member_id: String(member.member_id),
      handle
    });
  } catch (e) {
    console.error('[handle/login] error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/* --------------------- start phrase flow (explicit call) ------------------- */
// POST /api/identity/recovery/start { handle }
router.post('/recovery/start', async (req, res) => {
  try {
    const handle = normHandle(req.body?.handle);
    if (!handle) return res.status(422).json({ ok: false, error: 'invalid_handle' });

    const q = await pool.query(`SELECT member_id FROM ff_member WHERE username = $1 LIMIT 1`, [handle]);
    if (q.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });

    const token = await ensureRecoveryFor(q.rows[0].member_id);
    const correct = buildPhrase(token);
    const options = buildDecoys(correct, 7);

    return res.json({ ok: true, options });
  } catch (e) {
    console.error('[recovery/start] error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/* -------------------------- verify phrase selection ------------------------ */
// POST /api/identity/recovery/verify { handle, choice }
router.post('/recovery/verify', async (req, res) => {
  try {
    const handle = normHandle(req.body?.handle);
    const choice = String(req.body?.choice || '').trim();
    if (!handle || !choice) return res.status(422).json({ ok: false, error: 'bad_input' });

    const q = await pool.query(`SELECT member_id FROM ff_member WHERE username = $1 LIMIT 1`, [handle]);
    if (q.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });

    const token = await ensureRecoveryFor(q.rows[0].member_id);
    const correct = buildPhrase(token);

    if (choice !== correct) {
      return res.status(403).json({ ok: false, error: 'wrong_choice' });
    }

    // Success → set cookies & return FEIN
    setGoodCookies(res, { member_id: q.rows[0].member_id });
    const u = new URL('/fein', 'https://fortifiedfantasy.com');
    u.searchParams.set('season', String(new Date().getUTCFullYear()));
    return res.json({ ok: true, next: u.pathname + u.search });
  } catch (e) {
    console.error('[recovery/verify] error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/* ------------------------------- code verify ------------------------------- */
// POST /api/identity/verify-code { handle, code }
router.post('/verify-code', async (req, res) => {
  try {
    const handle = normHandle(req.body?.handle);
    const code = String(req.body?.code || '').trim();
    if (!handle || !/^\d{6}$/.test(code)) return res.status(422).json({ ok: false, error: 'bad_input' });

    const q = await pool.query(
      `SELECT member_id, login_code, login_code_expires
         FROM ff_member WHERE username = $1 LIMIT 1`,
      [handle]
    );
    if (q.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });

    const row = q.rows[0];
    const now = Date.now();
    const expOk = row.login_code_expires && new Date(row.login_code_expires).getTime() > now;

    if (row.login_code !== code || !expOk) {
      return res.status(403).json({ ok: false, error: 'invalid_or_expired' });
    }

    // Success → set cookies & return FEIN
    setGoodCookies(res, { member_id: row.member_id });
    const u = new URL('/fein', 'https://fortifiedfantasy.com');
    u.searchParams.set('season', String(new Date().getUTCFullYear()));
    return res.json({ ok: true, next: u.pathname + u.search });
  } catch (e) {
    console.error('[verify-code] error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
