// routes/zeffy.js
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// --- Config ---
const WEBHOOK_SECRET = process.env.ZEFFY_WEBHOOK_SECRET || '';
const POINTS_PER_DOLLAR = Number(process.env.FF_POINTS_PER_DOLLAR || 1);

// Ensure tables exist (cheap, safe to call at boot)
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeffy_payments (
      payment_id     text PRIMARY KEY,
      amount_cents   integer NOT NULL,
      currency       text NOT NULL,
      donor_email    text,
      donor_name     text,
      form_id        text,
      occurred_at    timestamptz NOT NULL,
      raw            jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_points_credits (
      id            bigserial PRIMARY KEY,
      member_id     text NOT NULL,
      source        text NOT NULL, -- 'zeffy'
      source_id     text NOT NULL, -- payment_id
      points        integer NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source, source_id)
    );
  `);
}
ensureTables().catch(console.error);

// --- Helpers ---
async function creditPointsIfPossible({ donorEmail, amountCents, paymentId }) {
  if (!donorEmail) return; // no email to map — silently skip

  // Map donor email -> member_id (tweak to your schema if emails live elsewhere)
  const { rows } = await pool.query(
    `SELECT member_id FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [donorEmail]
  );
  if (!rows.length) return;

  const points = Math.max(0, Math.floor((amountCents / 100) * POINTS_PER_DOLLAR));

  await pool.query(
    `INSERT INTO ff_points_credits (member_id, source, source_id, points)
     VALUES ($1,'zeffy',$2,$3)
     ON CONFLICT (source, source_id) DO NOTHING`,
    [rows[0].member_id, paymentId, points]
  );
}

// --- Route ---
router.post('/webhook', express.json(), async (req, res) => {
  try {
    if (!WEBHOOK_SECRET || req.get('X-Zeffy-Signature') !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Zapier "Webhooks by Zapier → POST" should send Zeffy fields through as JSON
    const p = req.body || {};

    // Try common field names; adjust if your Zap names differ
    const paymentId   = String(p.payment_id ?? p.id ?? '');
    const amountCents = Number(p.amount_cents ?? p.amount ?? 0);
    const currency    = String(p.currency || 'USD');
    const donorEmail  = String(p.donor_email ?? p.email ?? '').trim();
    const donorName   = String(p.donor_name ?? p.name ?? '').trim();
    const formId      = String(p.form_id ?? p.form ?? '').trim();
    const occurredAt  = new Date(p.created_at || p.timestamp || Date.now());

    if (!paymentId) {
      return res.status(400).json({ ok: false, error: 'missing_payment_id' });
    }

    // Idempotent write
    await pool.query(
      `INSERT INTO zeffy_payments
       (payment_id, amount_cents, currency, donor_email, donor_name, form_id, occurred_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId, amountCents, currency, donorEmail, donorName, formId, occurredAt, p]
    );

    // Fire-and-forget points credit (mapped by donor email)
    creditPointsIfPossible({ donorEmail, amountCents, paymentId })
      .catch(err => console.error('points_credit_failed', err));

    return res.json({ ok: true });
  } catch (err) {
    console.error('zeffy_webhook_failed', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
