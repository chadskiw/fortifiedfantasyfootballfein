// routes/points.js
const router = require('express').Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const PPD = Number(process.env.FF_POINTS_PER_DOLLAR || 1000);     // points per $1
const HOLD_TTL_MIN = Number(process.env.FF_HOLD_TTL_MINUTES || 15);
const HOUSE_ID = process.env.FF_HOUSE_MEMBER || 'HOUSE';
const ALLOW_QUERY_MEMBER = process.env.FF_ALLOW_QUERY_MEMBER === 'true'; // dev helper

// ------------------------------
// Cookie-only soft auth (no CORS needed)
// ------------------------------
function parseCookiesHeader(req) {
  const out = {};
  const raw = req.headers?.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}
function getCookies(req) { return req.cookies || parseCookiesHeader(req); }

function getMemberId(req) {
  const c = getCookies(req);
  // Primary: ff_logged_in=1 + ff_member_id=BADASS01 (matches your screenshot)
  if ((c.ff_logged_in === '1' || c.ff_logged_in === 1 || c.ff_logged_in === 'true') && c.ff_member_id)
    return String(c.ff_member_id);

  // Optional dev fallbacks (no CORS change required)
  if (req.headers['x-ff-member-id']) return String(req.headers['x-ff-member-id']);
  if (ALLOW_QUERY_MEMBER && req.query?.memberId) return String(req.query.memberId);
  if (ALLOW_QUERY_MEMBER && req.body?.memberId)  return String(req.body.memberId);

  return null;
}

function softAuth(req, res, next) {
  const mid = getMemberId(req);
  if (!mid) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.member_id = mid;
  next();
}

// ------------------------------
// Helpers
// ------------------------------
function idemKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

async function getMemberTotals(memberId) {
  // Same-origin friendly: compute CTE from zeffy_payments + adjust with ledger and open holds
  const sql = `
WITH zeffy AS (
  SELECT
    $1 AS member_id,
    -- cents * (PPD/100) in integer space
    (COALESCE(SUM(zp.amount_cents),0)::bigint * $2 / 100)::bigint AS cte
  FROM zeffy_payments zp
  LEFT JOIN ff_member m ON LOWER(m.email)=LOWER(zp.donor_email)
  WHERE COALESCE(zp.member_hint, m.member_id) = $1
),
ledger AS (
  SELECT COALESCE(SUM(
           CASE WHEN kind='debit' THEN -delta_points ELSE delta_points END
         ),0)::bigint AS delta_points
  FROM ff_points_ledger
  WHERE member_id = $1
    AND COALESCE(source,'') NOT IN ('deposit_zeffy','deposit_manual')
),
holds AS (
  SELECT COALESCE(SUM(amount_held),0)::bigint AS exposure
  FROM ff_holds
  WHERE member_id=$1 AND status='held' AND expires_at > now()
)
SELECT
  COALESCE((SELECT cte          FROM zeffy),0) AS cte,
  COALESCE((SELECT delta_points FROM ledger),0) AS delta,
  COALESCE((SELECT exposure     FROM holds),0) AS exposure;

  `;
  const { rows } = await pool.query(sql, [memberId, PPD]);
  const { cte = 0, delta = 0, exposure = 0 } = rows[0] || {};
  const balance = Number(cte) + Number(delta);
  const available = Math.max(0, balance - Number(exposure));
  return {
    cte: Number(cte),
    ledger: Number(delta),
    balance,
    exposure: Number(exposure),
    available,
    usd: (Number(cte) + Number(delta)) / PPD,
  };
}

// ------------------------------
// Debug helper (verify cookies → member_id)
// ------------------------------
router.get('/whoami', (req, res) => {
  res.json({
    ok: true,
    member_id: getMemberId(req),
    sawCookies: Object.keys(getCookies(req)),
  });
});

// ------------------------------
// GET /api/points/balance
// ------------------------------
router.get('/balance', softAuth, async (req, res) => {
  try {
    const t = await getMemberTotals(req.member_id);
    res.json({ ok: true, ...t });
  } catch (e) {
    console.error('points.balance.error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ------------------------------
// POST /api/points/hold
// body: { amount, product, season, week, scoring, playerA, playerB, memo, idem_hint? }
// ------------------------------
router.post('/hold', softAuth, async (req, res) => {
  try {
    const { amount, product = 'duels', season, week, scoring, playerA, playerB, memo, idem_hint } = req.body || {};
    const amt = Math.max(0, Math.floor(Number(amount || 0)));
    if (!amt) return res.status(400).json({ ok: false, error: 'bad_amount' });

    const t = await getMemberTotals(req.member_id);
    if (amt > t.available) return res.status(400).json({ ok: false, error: 'insufficient_funds', available: t.available });

    const meta = { season, week, scoring, playerA, playerB, product };
    const scopeId = (playerA && playerB) ? `${playerA}_${playerB}` : null;
    const computedMemo = memo || `${product}:${season || ''}:${week || ''}:${scoring || ''}:${playerA || ''}vs${playerB || ''}`;
    const key = idemKey({ member: req.member_id, amt, product, season, week, scoring, playerA, playerB, idem_hint: idem_hint || null });

    const { rows } = await pool.query(`
      WITH ins AS (
        INSERT INTO ff_holds
          (hold_id, member_id, currency, amount_held, amount_captured, amount_released, status,
           expires_at, scope_type, scope_id, memo, meta, idempotency_key, created_at, updated_at)
        VALUES (
          concat('hold_', replace(gen_random_uuid()::text,'-','')),
          $1, 'points', $2, 0, 0, 'held',
          NOW() + ($3 || ' minutes')::interval,
          $4, $5, $6, $7::jsonb, $8, NOW(), NOW()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING hold_id, expires_at
      )
      SELECT * FROM ins
      UNION ALL
      SELECT hold_id, expires_at
      FROM ff_holds
      WHERE idempotency_key = $8
      LIMIT 1
    `, [
      req.member_id, amt, HOLD_TTL_MIN,
      product, scopeId, computedMemo, JSON.stringify(meta), key
    ]);

    if (!rows[0]) return res.status(409).json({ ok: false, error: 'duplicate_hold' });
    res.json({ ok: true, hold_id: rows[0].hold_id, expires_at: rows[0].expires_at });
  } catch (e) {
    console.error('points.hold.error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ------------------------------
// POST /api/points/release-expired
// ------------------------------
router.post('/release-expired', async (_req, res) => {
  try {
    const { rowCount } = await pool.query(`
      UPDATE ff_holds
      SET status='released',
          amount_released=amount_held,
          released_at=NOW(),
          updated_at=NOW()
      WHERE status='held' AND expires_at < NOW()
    `);
    res.json({ ok: true, released: rowCount });
  } catch (e) {
    console.error('points.release_expired.error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ------------------------------
// GET /api/points/history  (ledger entries)
// ------------------------------
router.get('/history', softAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT entry_id, created_at, delta_points, kind, source, source_id, ref_type, ref_id, memo
      FROM ff_points_ledger
      WHERE member_id=$1
      ORDER BY created_at DESC
      LIMIT 500
    `, [req.member_id]);
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('points.history.error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ------------------------------
// POST /api/points/sync-zeffy (idempotent: zeffy → ledger)
// ------------------------------
router.post('/sync-zeffy', async (req, res) => {
  try {
    const since = req.body?.since ? new Date(req.body.since) : null;
    const params = [];
    let where = `COALESCE(zp.member_hint, m.member_id) IS NOT NULL`;
    if (since) { where += ` AND zp.occurred_at >= $1`; params.push(since.toISOString()); }

    const { rows } = await pool.query(`
      SELECT zp.payment_id, COALESCE(zp.member_hint, m.member_id) AS member_id, zp.amount_cents
      FROM zeffy_payments zp
      LEFT JOIN ff_member m ON LOWER(m.email)=LOWER(zp.donor_email)
      WHERE ${where}
    `, params);

    let imported = 0;
    for (const r of rows) {
// AFTER (correct: 10 pts / ¢ when PPD=1000)
const points = Math.round((r.amount_cents * PPD) / 100);
      const idem = idemKey({ k: 'deposit_zeffy', payment_id: r.payment_id, member_id: r.member_id, points });
      const q = await pool.query(`
        INSERT INTO ff_points_ledger
          (member_id, currency, delta_points, kind, source, source_id, memo, idempotency_key)
        VALUES ($1,'points',$2,'deposit_zeffy','zeffy',$3,'Zeffy deposit', $4)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [r.member_id, points, r.payment_id, idem]);
      imported += q.rowCount;
    }
    res.json({ ok: true, imported });
  } catch (e) {
    console.error('points.sync_zeffy.error', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
