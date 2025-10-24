// routes/users.js
const router = require('express').Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
const PPD = Number(process.env.FF_POINTS_PER_DOLLAR || 100);

// ---------- soft cookie auth (no CORS needed) ----------
function parseCookiesHeader(req){
  const out = {}; (req.headers.cookie||'').split(';').forEach(p=>{
    const i=p.indexOf('='); if(i>0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1));
  }); return out;
}
function getCookies(req){ return req.cookies || parseCookiesHeader(req); }
function getMemberId(req){
  const c = getCookies(req);
  if ((c.ff_logged_in==='1' || c.ff_logged_in==='true' || c.ff_logged_in===1) && c.ff_member_id) return String(c.ff_member_id);
  if (req.headers['x-ff-member-id']) return String(req.headers['x-ff-member-id']); // dev/admin
  return null;
}
function requireMember(req,res,next){
  const mid = getMemberId(req);
  if (!mid) return res.status(401).json({ ok:false, error:'unauthorized' });
  req.member_id = mid; next();
}

// ---------- helpers ----------
async function totalsFor(memberId){
  const sql = `
    WITH zeffy AS (
      SELECT COALESCE(SUM((zp.amount_cents/100.0)*$2),0)::bigint AS cte
      FROM zeffy_payments zp
      LEFT JOIN ff_member m ON LOWER(m.email)=LOWER(zp.donor_email)
      WHERE COALESCE(zp.member_hint, m.member_id) = $1
    ),
    ledger AS (
      SELECT COALESCE(SUM(delta_points),0)::bigint AS delta
      FROM ff_points_ledger WHERE member_id=$1
    ),
    holds AS (
      SELECT COALESCE(SUM(amount_held),0)::bigint AS exposure
      FROM ff_holds WHERE member_id=$1 AND status='held' AND expires_at>NOW()
    )
    SELECT COALESCE((SELECT cte FROM zeffy),0) AS cte,
           COALESCE((SELECT delta FROM ledger),0) AS delta,
           COALESCE((SELECT exposure FROM holds),0) AS exposure
  `;
  const { rows } = await pool.query(sql, [memberId, PPD]);
  const r = rows[0] || { cte:0, delta:0, exposure:0 };
  const balance = Number(r.cte) + Number(r.delta);
  const available = Math.max(0, balance - Number(r.exposure));
  return { cte:Number(r.cte), delta:Number(r.delta), balance, available, exposure:Number(r.exposure) };
}

async function wlFor(memberId){
  const { rows } = await pool.query(`
    SELECT
      SUM(CASE WHEN kind IN ('duels_payout','h2h_payout') THEN 1 ELSE 0 END)::int AS wins,
      SUM(CASE WHEN kind IN ('stake_captured_duels','stake_captured_h2h') THEN 1 ELSE 0 END)::int AS losses,
      COALESCE(SUM(delta_points),0)::bigint AS net_points
    FROM ff_points_ledger
    WHERE member_id=$1
  `, [memberId]);
  return rows[0] || { wins:0, losses:0, net_points:0 };
}

async function openHolds(memberId){
  const { rows } = await pool.query(`
    SELECT hold_id, amount_held, expires_at, memo
    FROM ff_holds
    WHERE member_id=$1 AND status='held' AND expires_at>NOW()
    ORDER BY expires_at ASC
  `, [memberId]);
  return rows;
}

async function myOpenChallenges(memberId){
  // return 1 row per challenge with both sides aggregated minimal
  const { rows } = await pool.query(`
    WITH mine AS (
      SELECT c.challenge_id AS id, c.season, c.week, c.status, c.stake_points, c.updated_at,
             jsonb_agg(
               jsonb_build_object(
                 'side', s.side, 'league_id', s.league_id, 'team_id', s.team_id,
                 'team_name', s.team_name, 'locked_at', s.locked_at, 'points_final', s.points_final
               ) ORDER BY s.side
             ) AS sides
      FROM ff_challenges c
      JOIN ff_challenge_sides s ON s.challenge_id=c.challenge_id
      WHERE (s.owner_member_id=$1 OR s.claimed_by_member_id=$1)
        AND c.status IN ('open','pending')
      GROUP BY c.challenge_id
    )
    SELECT * FROM mine ORDER BY updated_at DESC LIMIT 25
  `, [memberId]);
  return rows;
}

async function recentLedger(memberId){
  const { rows } = await pool.query(`
    SELECT created_at, delta_points, kind, source, source_id, memo
    FROM ff_points_ledger
    WHERE member_id=$1
    ORDER BY created_at DESC
    LIMIT 20
  `, [memberId]);
  return rows;
}

// ---------- routes ----------

// Signed-in dashboard
router.get('/user/dashboard', requireMember, async (req,res)=>{
  try {
    const [tot, wl, holds, ch, led] = await Promise.all([
      totalsFor(req.member_id),
      wlFor(req.member_id),
      openHolds(req.member_id),
      myOpenChallenges(req.member_id),
      recentLedger(req.member_id),
    ]);
    res.json({ ok:true, member_id: req.member_id, totals: tot, wl, holds, challenges: ch, ledger: led, usd: (tot.balance/PPD) });
  } catch (e) {
    console.error('user.dashboard.error', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// Public profile by memberId (you can add a by-handle alias later)
router.get('/users/:memberId/profile', async (req,res)=>{
  try {
    const mid = String(req.params.memberId);
    const [wl, ch] = await Promise.all([
      wlFor(mid),
      myOpenChallenges(mid)
    ]);
    // basic profile
    const { rows: m } = await pool.query(`SELECT $1::text AS member_id`, [mid]); // expand when you add handle/avatar
    res.json({ ok:true, profile: { member_id: mid, handle: null, avatar: null }, wl, open_challenges: ch });
  } catch (e) {
    console.error('users.profile.error', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

module.exports = router;
