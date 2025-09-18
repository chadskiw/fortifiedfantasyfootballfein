// routes/identity-api.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

/* ---------- validators ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^\+?[0-9\-\s().]{7,}$/;

function normalizeIdentifier(raw) {
  const v = String(raw || '').trim();
  if (!v) return { type: null, value: '' };
  if (EMAIL_RE.test(v)) return { type: 'email', value: v.toLowerCase() };
  if (PHONE_RE.test(v)) {
    const digits = v.replace(/[^\d]/g, '');
    return { type: 'phone', value: digits.startsWith('1') && digits.length === 11 ? `+${digits}` : `+${digits}` };
  }
  return { type: 'username', value: v };
}

/* ---------- db (optional but supported) ---------- */
let pool = null;
if (process.env.DATABASE_URL && process.env.ID_INVITES_DB !== '0') {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
}

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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ff_invite_ident_uq
    ON ff_invite(identifier_type, identifier_value);
  `);
}

/* ---------- CORS preflight (your global middleware also handles it) ---------- */
router.options('/request-code', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin || 'https://fortifiedfantasy.com',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
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

    if (pool) {
      await ensureInviteTable();
      // Idempotent seed
      await pool.query(
        `INSERT INTO ff_invite (identifier_type, identifier_value)
         VALUES ($1,$2)
         ON CONFLICT (identifier_type, identifier_value)
         DO UPDATE SET status='seeded'`,
        [norm.type, norm.value]
      );
    }

    // Cross-site cookie on auth domain (onrender)
    res.cookie('ff-interacted', '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',  // required for cross-site + credentials
      path: '/',
      maxAge: 365*24*60*60*1000,
    });

    // (Optional) send code; don't crash in dev
    try {
      // await sendEmailOrSms(norm.type, norm.value)
    } catch (e) {
      console.warn('sendCode failed:', e?.message);
    }

    return res.status(200).json({ ok:true });
  } catch (err) {
    console.error('identity.request-code error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
