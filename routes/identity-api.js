// routes/identity-api.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

/* ---------- helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return { type: null, value: '' };
  if (EMAIL_RE.test(v)) return { type: 'email', value: v.toLowerCase() };
  if (PHONE_RE.test(v)) {
    const digits = v.replace(/[^\d]/g, '');
    const e164 = digits.length === 11 && digits.startsWith('1') ? `+${digits}` : `+${digits}`;
    return { type: 'phone', value: e164 };
  }
  return { type: 'username', value: v };
}

/* ---------- optional DB (guarded) ---------- */
let pool = null;
const wantDb = !!process.env.DATABASE_URL && process.env.ID_INVITES_DB !== '0';
if (wantDb) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
}

/* Ensure table exists (optional) */
async function ensureInviteTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_invite (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'seeded'
    );
  `);
}

/* ---------- CORS preflight for this router ---------- */
router.options('*', (req, res) => {
  // your global corsMiddleware also runs, but this makes OPTIONS explicit here
  res.set({
    'Access-Control-Allow-Origin': 'https://fortifiedfantasy.com',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  });
  res.sendStatus(204);
});

/* ---------- POST /api/identity/request-code ---------- */
router.post('/request-code', async (req, res) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok:false, error:'unsupported_media_type' });
    }

    const { identifier } = req.body || {};
    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ ok:false, error:'bad_request', detail:'identifier required' });
    }

    const norm = normalizeIdentifier(identifier);
    if (!norm.type) {
      return res.status(400).json({ ok:false, error:'bad_request', detail:'invalid identifier' });
    }

    // Seed invite if DB enabled
    if (pool) {
      await ensureInviteTable();
      await pool.query(
        `INSERT INTO ff_invite (identifier_type, identifier_value) VALUES ($1,$2)`,
        [norm.type, norm.value]
      );
    }

    // Set cross-site cookie on *this* host (onrender.com)
    // (This cookie will NOT be sent to fortifiedfantasy.com; it lives on the auth service.)
    res.cookie('ff-interacted', '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',   // required for cross-site fetch with credentials
      path: '/',
      maxAge: 365*24*60*60*1000
    });

    // (Optional) Attempt to dispatch a code; keep non-fatal in dev
    try {
      // await sendEmailOrSms(norm) // implement later
    } catch (e) {
      console.warn('sendCode failed:', e?.message);
    }

    return res.status(200).json({ ok:true });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ---------- (optional) POST /api/identity/verify-code ---------- */
router.post('/verify-code', async (req, res) => {
  try {
    // stub so frontend won’t 404 if you add it later
    return res.status(200).json({ ok:true, verified:false });
  } catch (err) {
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
