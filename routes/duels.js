// routes/duels.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');
const { requireMember } = require('./identity/me');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const HOUSE_ID = process.env.FF_HOUSE_MEMBER || 'HOUSE';
const DEFAULT_HOUSE_RATE = Number(process.env.FF_HOUSE_RATE || 0.045); // 4.5%

function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

/**
 * POST /api/duels/settle
 * body: { hold_id, duel_id, underdog_won:boolean, house_rate?:number }
 * Effect:
 *  - capture hold
 *  - ledger: -stake (stake_captured_duels)
 *  - if win: +payout to member, +rake to HOUSE
 *  - if loss: +stake to HOUSE (house_take_duels)
 */
router.post('/settle', async (req, res) => {
  const { hold_id, duel_id, underdog_won, house_rate } = req.body || {};
  if (!hold_id || !duel_id || typeof underdog_won !== 'boolean') {
    return res.status(400).json({ ok:false, error:'missing_args' });
  }
  const houseRate = Math.max(0, Math.min(0.5, Number(house_rate ?? DEFAULT_HOUSE_RATE)));

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    // lock the hold
    const { rows: hrows } = await cli.query(
      `SELECT * FROM ff_holds WHERE hold_id=$1 FOR UPDATE`, [hold_id]
    );
    const h = hrows[0];
    if (!h) throw new Error('hold_not_found');
    if (h.status !== 'held') throw new Error('invalid_status');

    const stake = Number(h.amount_held);
    const memberId = h.member_id;

    // mark captured
    await cli.query(
      `UPDATE ff_holds SET status='captured', amount_captured=amount_held, captured_at=NOW(), updated_at=NOW() WHERE hold_id=$1`,
      [hold_id]
    );

    // ledger: -stake (captured)
    const idemCaptured = idemKey({ k:'stake_captured_duels', hold_id, duel_id, memberId, stake });
    await cli.query(`
      INSERT INTO ff_points_ledger
        (member_id, currency, delta_points, kind, source, source_id, ref_type, ref_id, memo, idempotency_key)
      VALUES ($1,'points',$2,'stake_captured_duels','duels',$3,'hold',$4,'Stake captured', $5)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [memberId, -stake, duel_id, hold_id, idemCaptured]);

    if (underdog_won) {
      // payout = 2x stake * (1-houseRate)
      const gross = stake * 2;
      const payout = Math.floor(gross * (1 - houseRate));
      const rake = gross - payout;

      const idemPayout = idemKey({ k:'duels_payout', duel_id, memberId, payout });
      await cli.query(`
        INSERT INTO ff_points_ledger
          (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
        VALUES ($1,'points',$2,'duels_payout','duels',$3,'Underdog win payout', $4)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [memberId, payout, duel_id, idemPayout]);

      const idemRake = idemKey({ k:'duels_rake', duel_id, rake });
      await cli.query(`
        INSERT INTO ff_points_ledger
          (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
        VALUES ($1,'points',$2,'rake','duels',$3,'House rake', $4)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [HOUSE_ID, rake, duel_id, idemRake]);
    } else {
      // house takes stake on loss
      const idemHouseTake = idemKey({ k:'duels_house_take', duel_id, memberId, stake });
      await cli.query(`
        INSERT INTO ff_points_ledger
          (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
        VALUES ($1,'points',$2,'duels_house_take','duels',$3,'House takes losing stake', $4)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [HOUSE_ID, stake, duel_id, idemHouseTake]);
    }

    await cli.query('COMMIT');
    return res.json({ ok:true });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('duels.settle.error', e);
    return res.status(400).json({ ok:false, error:e.message });
  } finally {
    cli.release();
  }
});

module.exports = router;
