// routes/zeffy.js
const express = require('express');
const { Pool } = require('pg');
// pull in your DB helpers:
const { sql } = require('../src/db');                  // <- replace with your pg/pool helper
const { requireMember } = require('../routes/identity/me');    
const router = express.Router();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// --- Config ---
const WEBHOOK_SECRET = process.env.ZEFFY_WEBHOOK_SECRET || '';
const POINTS_PER_DOLLAR = Number(process.env.FF_POINTS_PER_DOLLAR || 1);
// Convert USD -> points. Use your real rule; fallback $1 => 100 pts.
const usdToPoints = (usd) => Math.round(Number(usd) * 100);

// NOTE: choose ONE source of truth below.

// ---- A) If you already store Zeffy webhook events locally (recommended) ----
// Expected columns (example): id, external_id, amount_usd, email, member_hint, status, created_at, credited_at
async function fetchUncreditedDonationsForMemberFromDB(memberId) {
  return sql/*sql*/`
    SELECT id, external_id, amount_usd, email, member_hint, created_at
    FROM zeffy_events
    WHERE status = 'paid'
      AND credited_at IS NULL
      AND (member_hint = ${memberId} OR email IN (
            SELECT email FROM ff_member WHERE member_id = ${memberId} AND email_is_verified = true
          ))
    ORDER BY created_at DESC
  `;
}

// ---- B) If you do NOT store webhooks yet, query Zeffy API on demand (fill in their API) ----
// Placeholder function – wire to Zeffy’s API and return an array like above.
async function fetchUncreditedDonationsForMemberFromZeffyAPI(memberId) {
  // TODO: implement with Zeffy API (campaign filter + created_since). Match on metadata.member_id or on donor email.
  return [];
}

// Idempotent write to your points ledger
async function creditIfNew({ memberId, externalId, amountUsd, source = 'zeffy' }) {
  // ensure uniqueness by externalId
  const points = usdToPoints(amountUsd);
  const row = await sql/*sql*/`
    INSERT INTO ff_points_ledger (member_id, points, usd_amount, source, external_tx_id)
    VALUES (${memberId}, ${points}, ${amountUsd}, ${source}, ${externalId})
    ON CONFLICT (external_tx_id) DO NOTHING
    RETURNING id, points
  `;
  return row[0]?.points || 0;
}

router.post('/sync', requireMember, async (req, res) => {
  try {
    const memberId = req.member_id || req.body.memberId;
    if (!memberId) return res.status(401).json({ ok:false, error:'unauthorized' });

    // Pick A or B based on what you have today
    let donations = await fetchUncreditedDonationsForMemberFromDB(memberId);
    if (!donations?.length) {
      donations = await fetchUncreditedDonationsForMemberFromZeffyAPI(memberId);
    }

    let totalPoints = 0, count = 0;
    for (const d of donations) {
      const added = await creditIfNew({
        memberId,
        externalId: d.external_id || `zeffy:${d.id}`,
        amountUsd: d.amount_usd
      });
      if (added > 0) {
        totalPoints += added;
        count += 1;
        // mark local webhook row as credited, if you have it
        if (d.id) {
          await sql/*sql*/`UPDATE zeffy_events SET credited_at = NOW() WHERE id = ${d.id}`;
        }
      }
    }

    if (count === 0) return res.status(200).json({ ok:false, error:'No new credits found' });
    res.json({ ok:true, count, total_points: totalPoints });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message });
  }
});
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
