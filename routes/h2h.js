// routes/h2h.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const HOUSE_ID = process.env.FF_HOUSE_MEMBER || 'HOUSE';
const DEFAULT_HOUSE_RATE = Number(process.env.FF_H2H_HOUSE_RATE || 0.045);

function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

/**
 * POST /api/h2h/settle
 * body: { ch_id, winner: 'home'|'away', house_rate?:number }
 * Uses ff_holds rows with memo like 'h2h:ch_<id>:home' and 'h2h:ch_<id>:away'
 * Effect:
 *  - capture both holds
 *  - ledger: -stake (for both sides)
 *  - winner: +pot*(1-houseRate)
 *  - house: +rake
 */
router.post('/settle', async (req, res) => {
  const { ch_id, winner, house_rate } = req.body || {};
  if (!ch_id || !['home','away'].includes(winner)) {
    return res.status(400).json({ ok:false, error:'missing_args' });
  }
  const houseRate = Math.max(0, Math.min(0.5, Number(house_rate ?? DEFAULT_HOUSE_RATE)));

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    // fetch & lock both sides
    const { rows: holds } = await cli.query(
      `SELECT * FROM ff_holds WHERE status='held' AND memo IN ($1,$2) FOR UPDATE`,
      [`h2h:${ch_id}:home`, `h2h:${ch_id}:away`]
    );
    if (holds.length < 1) throw new Error('holds_not_found');
    const home = holds.find(h => h.memo.endsWith(':home'));
    const away = holds.find(h => h.memo.endsWith(':away'));
    if (!home || !away) throw new Error('both_sides_required');

    // capture both
    await cli.query(
      `UPDATE ff_holds SET status='captured', amount_captured=amount_held, captured_at=NOW(), updated_at=NOW()
       WHERE hold_id = ANY($1::text[])`,
      [[home.hold_id, away.hold_id]]
    );

    // ledger: -stake for both
    const mkStakeRow = (h) => cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, ref_type, ref_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'stake_captured_h2h','h2h',$3,'hold',$4,'Stake captured', $5)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [h.member_id, -Number(h.amount_held), ch_id, h.hold_id, idemKey({k:'stake_captured_h2h', ch_id, hold:h.hold_id})]);

    await Promise.all([mkStakeRow(home), mkStakeRow(away)]);

    const pot = Number(home.amount_held) + Number(away.amount_held);
    const payout = Math.floor(pot * (1 - houseRate));
    const rake   = pot - payout;
    const winnerMember = (winner === 'home') ? home.member_id : away.member_id;

    // winner payout
    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'h2h_payout','h2h',$3,'Winner payout', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [winnerMember, payout, ch_id, idemKey({k:'h2h_payout', ch_id, winner: winnerMember, payout})]);

    // house rake
    await cli.query(`
      INSERT INTO ff_points_ledger (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'rake','h2h',$3,'House rake', $4)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [HOUSE_ID, rake, ch_id, idemKey({k:'h2h_rake', ch_id, rake})]);

    await cli.query('COMMIT');
    return res.json({ ok:true, pot, payout, rake });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('h2h.settle.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  } finally {
    cli.release();
  }
});

module.exports = router;
