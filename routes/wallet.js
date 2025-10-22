// routes/wallet.js
const express = require('express');
const crypto  = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const asInt = (v, d=0) => Number.isFinite(+v) ? Math.round(+v) : d;
const clampPosInt = (v) => Math.max(0, asInt(v, 0));
const newId = (p='hold_') => p + crypto.randomUUID().replace(/-/g,'').slice(0,16);

function getMember(req){
  // honor explicit header first; fall back to cookies if you have cookie-parser
  return (
    req.headers['x-ff-member'] ||
    req.headers['x-member-id'] ||
    req.cookies?.ff_member_id ||
    req.cookies?.member_id ||
    null
  );
}

/**
 * POST /api/wallet/hold
 * body: { amount, currency?, memo?, ttlSeconds?, scope_type?, scope_id?, idempotency_key? }
 * response: { ok:true, hold_id, pending }
 */
router.post('/hold', express.json(), async (req, res) => {
  try {
    const member = getMember(req);
    if (!member) return res.status(401).json({ ok:false, error:'unauthorized' });

    const {
      amount,
      currency = 'points',
      memo = '',
      ttlSeconds = 15 * 60,
      scope_type = null,
      scope_id   = null,
    } = req.body || {};

    const idempotency_key = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
    const amt = clampPosInt(amount);
    if (!amt) return res.status(400).json({ ok:false, error:'invalid_amount' });
    if (!['points','usd','credits'].includes(String(currency))) {
      return res.status(400).json({ ok:false, error:'invalid_currency' });
    }

    const expiresSQL = `now() + make_interval(secs => $1::int)`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (idempotency_key){
        const { rows: existing } = await client.query(
          `SELECT hold_id, amount_held AS pending FROM ff_holds
           WHERE member_id=$1 AND idempotency_key=$2 LIMIT 1`,
          [member, idempotency_key]
        );
        if (existing.length){
          await client.query('COMMIT');
          return res.json({ ok:true, hold_id: existing[0].hold_id, pending: existing[0].pending, idempotent:true });
        }
      }

      const hold_id = newId();
// routes/wallet.js (inside POST /hold)
-    const expiresSQL = `now() + make_interval(secs => $1::int)`;
...
-      const insert = await client.query(
-        `INSERT INTO ff_holds
-           (hold_id, member_id, currency, amount_held, status, expires_at, scope_type, scope_id, memo, idempotency_key)
-         VALUES ($1,$2,$3,$4,'held', ${expiresSQL}, $5,$6,$7,$8)
-         RETURNING hold_id, amount_held`,
-        [hold_id, member, currency, amt, scope_type, scope_id, memo, idempotency_key]
-      );
+      const ttl = clampPosInt(ttlSeconds ?? 900); // default 15 min
+      const insert = await client.query(
+        `INSERT INTO ff_holds
+           (hold_id, member_id, currency, amount_held, status, expires_at, scope_type, scope_id, memo, idempotency_key)
+         VALUES ($1,$2,$3,$4,'held', (now() + ($9::int) * INTERVAL '1 second'), $5,$6,$7,$8)
+         RETURNING hold_id, amount_held`,
+        [hold_id, member, currency, amt, scope_type, scope_id, memo, idempotency_key, ttl]
+      );


      await client.query('COMMIT');
      return res.json({ ok:true, hold_id: insert.rows[0].hold_id, pending: insert.rows[0].amount_held });
    } catch (e){
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }
  } catch (err){
    console.error('[wallet/hold] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/**
 * POST /api/wallet/capture
 * body: { hold_id, amount? }  // default: capture remaining
 * - prevents capture if expired or already fully resolved
 */
router.post('/capture', express.json(), async (req, res) => {
  const { hold_id, amount } = req.body || {};
  if (!hold_id) return res.status(400).json({ ok:false, error:'missing_hold_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // lock the row
    const { rows } = await client.query(`SELECT * FROM ff_holds WHERE hold_id=$1 FOR UPDATE`, [hold_id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'hold_not_found' }); }
    const h = rows[0];

    if (h.status === 'captured')           { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, error:'already_captured' }); }
    if (h.status === 'released')           { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, error:'already_released' }); }
    if (h.status === 'void')               { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, error:'hold_void' }); }
    if (h.status === 'expired' || new Date(h.expires_at) < new Date()) {
      await client.query(`UPDATE ff_holds SET status='expired' WHERE hold_id=$1`, [hold_id]);
      await client.query('COMMIT');
      return res.status(409).json({ ok:false, error:'hold_expired' });
    }

    const remaining = h.amount_held - h.amount_captured - h.amount_released;
    if (remaining <= 0) {
      const final = (h.amount_captured >= h.amount_held) ? 'captured' : 'released';
      await client.query(`UPDATE ff_holds SET status=$2 WHERE hold_id=$1`, [hold_id, final]);
      await client.query('COMMIT');
      return res.json({ ok:true, hold_id, captured:h.amount_captured, released:h.amount_released, status:final });
    }

    const toCapture = clampPosInt(amount ?? remaining);
    if (toCapture <= 0)  { await client.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'invalid_amount' }); }
    if (toCapture > remaining) { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, error:'insufficient_available' }); }

    const newCaptured = h.amount_captured + toCapture;
    const status = (newCaptured >= h.amount_held) ? 'captured' : 'partially_captured';

    const upd = await client.query(
      `UPDATE ff_holds
         SET amount_captured = $2,
             status = $3,
             captured_at = CASE WHEN captured_at IS NULL THEN now() ELSE captured_at END
       WHERE hold_id=$1
       RETURNING hold_id, member_id, amount_held, amount_captured, amount_released, currency, status`,
      [hold_id, newCaptured, status]
    );

    // TODO: insert into ff_points_ledger here if you want settlement rows
    await client.query('COMMIT');
    const r = upd.rows[0];
    res.json({ ok:true, hold_id: r.hold_id, captured: r.amount_captured, released: r.amount_released, status: r.status });
  } catch (err){
    await client.query('ROLLBACK');
    console.error('[wallet/capture] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/wallet/release
 * body: { hold_id, amount? }  // default: release remaining
 */
router.post('/release', express.json(), async (req, res) => {
  const { hold_id, amount } = req.body || {};
  if (!hold_id) return res.status(400).json({ ok:false, error:'missing_hold_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT * FROM ff_holds WHERE hold_id=$1 FOR UPDATE`, [hold_id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'hold_not_found' }); }
    const h = rows[0];

    if (['released','captured','void'].includes(h.status)) {
      await client.query('COMMIT');
      return res.json({ ok:true, hold_id, captured: h.amount_captured, released: h.amount_released, status: h.status });
    }

    const remaining = h.amount_held - h.amount_captured - h.amount_released;
    if (remaining <= 0) {
      const final = (h.amount_captured >= h.amount_held) ? 'captured' : 'released';
      await client.query(`UPDATE ff_holds SET status=$2 WHERE hold_id=$1`, [hold_id, final]);
      await client.query('COMMIT');
      return res.json({ ok:true, hold_id, captured:h.amount_captured, released:h.amount_released, status:final });
    }

    const toRelease = clampPosInt(amount ?? remaining);
    if (toRelease <= 0)  { await client.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'invalid_amount' }); }
    if (toRelease > remaining) { await client.query('ROLLBACK'); return res.status(409).json({ ok:false, error:'insufficient_available' }); }

    const newReleased = h.amount_released + toRelease;
    const status = (newReleased + h.amount_captured >= h.amount_held) ? 'released' : h.status;

    const upd = await client.query(
      `UPDATE ff_holds
         SET amount_released = $2,
             status = $3,
             released_at = CASE WHEN $3='released' THEN now() ELSE released_at END
       WHERE hold_id=$1
       RETURNING hold_id, amount_captured, amount_released, status`,
      [hold_id, newReleased, status]
    );

    // TODO: insert refund rows into ff_points_ledger here if you track pending
    await client.query('COMMIT');
    const r = upd.rows[0];
    res.json({ ok:true, hold_id: r.hold_id, captured: r.amount_captured, released: r.amount_released, status: r.status });
  } catch (err){
    await client.query('ROLLBACK');
    console.error('[wallet/release] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/wallet/expire-scan
 * - marks stale holds as expired (you can call this on a cron)
 */
router.post('/expire-scan', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE ff_holds
         SET status='expired'
       WHERE status='held' AND expires_at < now()
       RETURNING hold_id`
    );
    res.json({ ok:true, expired: rows.map(r => r.hold_id) });
  } catch (err){
    console.error('[wallet/expire-scan] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/** Optional: lookup */
router.get('/holds/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM ff_holds WHERE hold_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok:false, error:'hold_not_found' });
    res.json({ ok:true, hold: rows[0] });
  } catch (err){
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
