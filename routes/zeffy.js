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
const MID_RE = /^[A-Z0-9]{6,12}$/;
const normMid = s => (s || '').toString().trim().toUpperCase();

function extractMemberHint(p) {
  const c = [];

  // obvious keys / metadata
  c.push(p.member_id, p.memberId, p.ff_member_id, p.metadata?.member_id, p.custom_fields?.member_id);

  // Zap / Zeffy custom field names
  c.push(p['Fortified Fantasy Member Id'], p['fortified_fantasy_member_id']);

  // Q&A arrays e.g. [{question:'Fortified Fantasy Member Id', answer:'BADASS01'}]
  if (Array.isArray(p.answers)) {
    for (const a of p.answers) {
      if (typeof a?.question === 'string' && a.question.toLowerCase().includes('member')) {
        c.push(a.answer);
      }
    }
  }

  const hit = c.map(normMid).find(v => MID_RE.test(v));
  return hit || null;
}

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

// Sync any uncredited Zeffy payments to this member's points
router.post('/sync', requireMember, async (req, res) => {
  try {
    const memberId = req.member_id || req.body?.memberId;
    if (!memberId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // pulls from zeffy_payments with member_hint/email fallback
    const donations = await fetchUncreditedDonationsForMemberFromDB(memberId);

    if (!donations?.length) {
      // optional Zeffy API fallback, if you wire it later
      // const fromApi = await fetchUncreditedDonationsForMemberFromZeffyAPI(memberId);
      // if (!fromApi?.length) return res.status(200).json({ ok: false, error: 'No new credits found' });
      return res.status(200).json({ ok: false, error: 'No new credits found' });
    }

    let totalPoints = 0;
    let count = 0;

    for (const d of donations) {
      // creditIfNew() writes to ff_points_credits with unique (source, source_id)
      const added = await creditIfNew({
        memberId,
        paymentId: d.payment_id,
        amountUsd: d.amount_cents / 100
      });
      if (added > 0) {
        totalPoints += added;
        count += 1;
      }
    }

    if (count === 0) return res.status(200).json({ ok: false, error: 'No new credits found' });
    return res.json({ ok: true, count, total_points: totalPoints });
  } catch (e) {
    console.error('zeffy_sync_failed', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// Ensure tables exist (cheap, safe to call at boot)
async function ensureTables() {
// in ensureTables()
await pool.query(`
  CREATE TABLE IF NOT EXISTS zeffy_payments (
    payment_id   text PRIMARY KEY,
    amount_cents integer NOT NULL,
    currency     text NOT NULL,
    donor_email  text,
    donor_name   text,
    form_id      text,
    occurred_at  timestamptz NOT NULL,
    raw          jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  );
`);

// NEW: add member_hint + index
await pool.query(`ALTER TABLE zeffy_payments ADD COLUMN IF NOT EXISTS member_hint text;`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_zeffy_payments_member_hint ON zeffy_payments (UPPER(member_hint));`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS ff_points_credits (
    id         bigserial PRIMARY KEY,
    member_id  text NOT NULL,
    source     text NOT NULL,
    source_id  text NOT NULL,
    points     integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
  );
`);

}
ensureTables().catch(console.error);

// --- Helpers ---
async function creditPointsIfPossible({ memberIdHint, donorEmail, amountCents, paymentId }) {
  let memberId = null;

  if (memberIdHint) {
    const mid = normMid(memberIdHint);
    const r = await pool.query(`SELECT member_id FROM ff_member WHERE member_id=$1 LIMIT 1`, [mid]);
    if (r.rows.length) memberId = r.rows[0].member_id;
  }

  if (!memberId && donorEmail) {
    const r = await pool.query(
      `SELECT member_id FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [donorEmail]
    );
    if (r.rows.length) memberId = r.rows[0].member_id;
  }

  if (!memberId) return; // nothing to map

  const points = Math.max(0, Math.floor((amountCents / 100) * POINTS_PER_DOLLAR));
  await pool.query(
    `INSERT INTO ff_points_credits (member_id, source, source_id, points)
     VALUES ($1,'zeffy',$2,$3)
     ON CONFLICT (source, source_id) DO NOTHING`,
    [memberId, paymentId, points]
  );
}

// --- Route ---
router.post('/webhook', express.json(), async (req, res) => {
  try {
    if (!WEBHOOK_SECRET || req.get('X-Zeffy-Signature') !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const p = req.body || {};

    const paymentId   = String(p.payment_id ?? p.id ?? '');
    const amountCents = Number(p.amount_cents ?? p.amount ?? 0);
    const currency    = String(p.currency || 'USD');
    const donorEmail  = String(p.donor_email ?? p.email ?? '').trim();
    const donorName   = String(p.donor_name ?? p.name ?? '').trim();
    const formId      = String(p.form_id ?? p.form ?? '').trim();
    const occurredAt  = new Date(p.created_at || p.timestamp || Date.now());
    const memberHint  = extractMemberHint(p);

    if (!paymentId) return res.status(400).json({ ok:false, error:'missing_payment_id' });

    await pool.query(
      `INSERT INTO zeffy_payments
         (payment_id, amount_cents, currency, donor_email, donor_name, form_id, occurred_at, raw, member_hint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (payment_id) DO UPDATE SET
         raw = EXCLUDED.raw,
         member_hint = COALESCE(NULLIF(EXCLUDED.member_hint,''), zeffy_payments.member_hint)`,
      [paymentId, amountCents, currency, donorEmail, donorName, formId, occurredAt, p, memberHint]
    );

    creditPointsIfPossible({ memberIdHint: memberHint, donorEmail, amountCents, paymentId })
      .catch(err => console.error('points_credit_failed', err));

    return res.json({ ok:true });
  } catch (err) {
    console.error('zeffy_webhook_failed', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
async function fetchUncreditedDonationsForMemberFromDB(memberId) {
  const q = `
    SELECT p.payment_id, p.amount_cents, p.donor_email, p.member_hint, p.occurred_at
    FROM zeffy_payments p
    LEFT JOIN ff_points_credits c
      ON c.source='zeffy' AND c.source_id=p.payment_id
    LEFT JOIN ff_member m
      ON m.member_id = $1
    WHERE c.id IS NULL
      AND (
        UPPER(p.member_hint) = UPPER($1)         -- PRIMARY: typed member id
        OR (LOWER(p.donor_email) = LOWER(m.email)) -- fallback by email (no verified flag)
      )
    ORDER BY p.occurred_at DESC
  `;
  const { rows } = await pool.query(q, [memberId]);
  return rows;
}


async function creditIfNew({ memberId, paymentId, amountUsd }) {
  const points = Math.max(0, Math.floor(amountUsd * POINTS_PER_DOLLAR));
  const q = `
    INSERT INTO ff_points_credits (member_id, source, source_id, points)
    VALUES ($1,'zeffy',$2,$3)
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING id, points
  `;
  const { rows } = await pool.query(q, [memberId, paymentId, points]);
  return rows[0]?.points || 0;
}


module.exports = router;
