// routes/zeffy_embed_credit.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function authedMemberId(req){
  // however you attach auth; or read validated cookies in middleware
  return req.user?.member_id || req.cookies?.ff_member_id || null;
}

// Optimistic credit from embed message (idempotent)
router.post('/credit-from-embed', express.json(), async (req, res) => {
  try{
    const memberId = authedMemberId(req);
    if (!memberId) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { donation_id, amount_cents, currency='USD', email=null } = req.body || {};
    const points = Math.max(0, Number(amount_cents|0)); // points = dollars*100
    if (!donation_id || !points) return res.status(400).json({ ok:false, error:'bad_payload' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS zeffy_payments (
        payment_id text PRIMARY KEY,
        amount_cents integer NOT NULL,
        currency text NOT NULL,
        donor_email text,
        member_id text,
        source text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await pool.query(`
      INSERT INTO zeffy_payments (payment_id, amount_cents, currency, donor_email, member_id, source)
      VALUES ($1,$2,$3,$4,$5,'embed')
      ON CONFLICT (payment_id) DO NOTHING`,
      [donation_id, points, currency, email, memberId]
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ff_points_credits (
        id bigserial PRIMARY KEY,
        member_id text NOT NULL,
        source text NOT NULL,
        source_id text NOT NULL,
        points integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source, source_id)
      )`);

    await pool.query(`
      INSERT INTO ff_points_credits (member_id, source, source_id, points)
      VALUES ($1,'zeffy',$2,$3)
      ON CONFLICT (source, source_id) DO NOTHING`,
      [memberId, donation_id, points]
    );

    return res.json({ ok:true, points });
  }catch(e){
    console.error('credit-from-embed failed', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Poll for the newest donation credited for this member (via webhook or embed)
router.post('/poll-latest', express.json(), async (req, res) => {
  try{
    const memberId = authedMemberId(req);
    if (!memberId) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { rows } = await pool.query(`
      SELECT pc.source_id AS donation_id, pc.points, pc.created_at
      FROM ff_points_credits pc
      WHERE pc.member_id = $1 AND pc.source = 'zeffy'
      ORDER BY pc.created_at DESC
      LIMIT 1`, [memberId]);

    if (!rows.length) return res.json({ ok:true, found:false });

    return res.json({ ok:true, found:true, donation_id: rows[0].donation_id, amount_cents: rows[0].points, points_credited: rows[0].points });
  }catch(e){
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
