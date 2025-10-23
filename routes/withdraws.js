// routes/withdraws.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');
const { requireMember } = require('./identity/me');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

// POST /api/withdraws/request  { amount_points, method, destination }
router.post('/request', requireMember, async (req, res) => {
  try {
    const amount = Math.max(0, Math.floor(Number(req.body?.amount_points || 0)));
    const method = String(req.body?.method || 'square_egift');
    const destination = String(req.body?.destination || '').trim();
    if (!amount || !destination) return res.status(400).json({ ok:false, error:'bad_args' });

    // optional: enforce available balance
    const { rows: bal } = await pool.query(`SELECT * FROM ff_points_balance_v WHERE member_id=$1`, [req.member_id]).catch(()=>({rows:[]}));
    const available = bal?.[0]?.available_points ?? null;
    if (Number.isFinite(available) && amount > available)
      return res.status(400).json({ ok:false, error:'insufficient_funds', available });

    const { rows } = await pool.query(`
      INSERT INTO ff_withdrawals
        (withdraw_id, member_id, amount_points, method, destination, status, created_at, updated_at)
      VALUES (
        concat('wd_', replace(gen_random_uuid()::text,'-','')),
        $1,$2,$3,$4,'requested', NOW(), NOW()
      )
      RETURNING withdraw_id
    `, [req.member_id, amount, method, destination]);

    return res.json({ ok:true, withdraw_id: rows[0].withdraw_id });
  } catch (e) {
    console.error('withdraws.request.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  }
});

// POST /api/withdraws/pay { withdraw_id, ext_ref? }  -- admin action
router.post('/pay', async (req, res) => {
  const { withdraw_id, ext_ref } = req.body || {};
  if (!withdraw_id) return res.status(400).json({ ok:false, error:'missing_withdraw_id' });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const { rows } = await cli.query(`SELECT * FROM ff_withdrawals WHERE withdraw_id=$1 FOR UPDATE`, [withdraw_id]);
    const w = rows[0];
    if (!w) throw new Error('not_found');
    if (!['requested','approved'].includes(w.status)) throw new Error('bad_status');

    await cli.query(`UPDATE ff_withdrawals SET status='paid', ext_ref=$2, updated_at=NOW() WHERE withdraw_id=$1`, [withdraw_id, ext_ref || null]);

    // Ledger: -amount
    const idem = idemKey({ k:'withdrawal', withdraw_id, member: w.member_id, amt: w.amount_points });
    await cli.query(`
      INSERT INTO ff_points_ledger
        (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'withdrawal','withdraw',$3,'Withdrawal paid', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [w.member_id, -Number(w.amount_points), withdraw_id, idem]);

    await cli.query('COMMIT');
    return res.json({ ok:true });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('withdraws.pay.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  } finally {
    cli.release();
  }
});

// GET /api/withdraws/my
router.get('/my', requireMember, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT withdraw_id, amount_points, method, destination, status, created_at, updated_at
      FROM ff_withdrawals
      WHERE member_id=$1
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.member_id]);
    return res.json({ ok:true, items: rows });
  } catch (e) {
    console.error('withdraws.my.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  }
});

module.exports = router;
