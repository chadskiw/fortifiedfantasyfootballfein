// routes/points.js
const router = require('express').Router();
const { Pool } = require('pg');
const { requireMember } = require('./identity/me');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// $ per point conversion: points / PPD = USD
const PPD = Number(process.env.FF_POINTS_PER_DOLLAR || 1); // e.g. 1 => 1pt = $1, 100 => 100pts = $1

router.get('/balance', requireMember, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(points),0) AS pts
         FROM ff_points_credits
        WHERE member_id = $1`,
      [req.member_id]
    );
    const points = Number(rows?.[0]?.pts || 0);
    const usd = points / PPD;
    return res.json({ ok: true, points, usd });
  } catch (e) {
    console.error('points.balance.error', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
