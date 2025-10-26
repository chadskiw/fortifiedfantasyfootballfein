// routes/wallets.js
const express = require('express');

module.exports = function walletsRoutes(pool) {
  const router = express.Router();

  function resolveMemberId(req) {
    // Prefer explicit query; fall back to auth middleware if present; last-resort header
    return (
      (req.query.memberId && String(req.query.memberId).trim()) ||
      (req.user && (req.user.member_id || req.user.memberId)) ||
      (req.headers['x-ff-member-id'] && String(req.headers['x-ff-member-id']).trim()) ||
      ''
    );
  }

  // GET /api/wallets/balance?memberId=GABE0001
  router.get('/balance', async (req, res) => {
    try {
      const memberId = resolveMemberId(req);
      if (!memberId) return res.status(400).json({ ok: false, error: 'missing memberId' });

      let wallets = [];
      try {
        // fast path if the SQL function exists
        const r = await pool.query('SELECT * FROM ff_get_wallet_balances($1)', [memberId]);
        wallets = r.rows.map((r) => ({
          walletId: Number(r.wallet_id),
          memberId: r.member_id,
          kind: r.kind,
          currency: r.currency,
          posted: Number(r.posted_balance),
          locked: Number(r.locked_amount),
          available: Number(r.available),
        }));
      } catch (e) {
        // fallback CTE if function isn’t present
        const r = await pool.query(
          `
          WITH posted AS (
            SELECT wallet_id, COALESCE(SUM(amount),0) AS posted_balance
            FROM ff_ledger WHERE status='posted' GROUP BY wallet_id
          ),
          locked AS (
            SELECT wallet_id, COALESCE(SUM(amount),0) AS locked_amount
            FROM ff_hold WHERE status='active' GROUP BY wallet_id
          )
          SELECT w.wallet_id, w.member_id, w.kind, w.currency,
                 COALESCE(p.posted_balance,0) AS posted_balance,
                 COALESCE(l.locked_amount,0)  AS locked_amount,
                 COALESCE(p.posted_balance,0) - COALESCE(l.locked_amount,0) AS available
          FROM ff_wallet w
          LEFT JOIN posted p USING (wallet_id)
          LEFT JOIN locked l USING (wallet_id)
          WHERE w.member_id = $1
          ORDER BY w.kind, w.currency
          `,
          [memberId]
        );
        wallets = r.rows.map((r) => ({
          walletId: Number(r.wallet_id),
          memberId: r.member_id,
          kind: r.kind,
          currency: r.currency,
          posted: Number(r.posted_balance),
          locked: Number(r.locked_amount),
          available: Number(r.available),
        }));
      }

      const totals = wallets.reduce(
        (acc, w) => ({
          posted: acc.posted + w.posted,
          locked: acc.locked + w.locked,
          available: acc.available + w.available,
        }),
        { posted: 0, locked: 0, available: 0 }
      );

      return res.json({ ok: true, memberId, wallets, totals });
    } catch (err) {
      console.error('GET /api/wallets/balance error:', err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // GET /api/wallets/where?memberId=GABE0001
  router.get('/where', async (req, res) => {
    try {
      const memberId = resolveMemberId(req);
      if (!memberId) return res.status(400).json({ ok: false, error: 'missing memberId' });

      // Choose your primary wallet (PLAY/POINT); extend later for multi-wallet breakdown
      const wq = await pool.query(
        `SELECT wallet_id FROM ff_wallet WHERE member_id=$1 AND kind='PLAY' AND currency='POINT' LIMIT 1`,
        [memberId]
      );
      const walletId = wq.rows[0]?.wallet_id;

      if (!walletId) {
        return res.json({
          ok: true,
          available: 0,
          locked: [],
          pendingDeposits: [],
          pendingWithdrawals: [],
          recentActivity: [],
        });
      }

      // Active holds (in play)
      const holdsQ = await pool.query(
        `
        SELECT hold_id, amount, reason, ref_type, ref_id, created_at
        FROM ff_hold
        WHERE wallet_id=$1 AND status='active'
        ORDER BY created_at DESC
        LIMIT 200
        `,
        [walletId]
      );
      const holds = holdsQ.rows.map((h) => ({
        holdId: Number(h.hold_id),
        amount: Number(h.amount),
        reason: h.reason,
        ref: h.ref_type || h.ref_id ? { type: h.ref_type, id: h.ref_id } : null,
        since: h.created_at,
      }));

      // Pending deposits (exclude confirmed; those are already credited)
      const depsQ = await pool.query(
        `
        SELECT deposit_id, provider, provider_ref, gross_cents, fee_cents, status, seen_at
        FROM ff_deposit
        WHERE member_id=$1 AND status IN ('seen','pending')
        ORDER BY seen_at DESC
        LIMIT 50
        `,
        [memberId]
      );
      const pendingDeposits = depsQ.rows.map((d) => ({
        depositId: Number(d.deposit_id),
        provider: d.provider,
        providerRef: d.provider_ref,
        grossCents: Number(d.gross_cents),
        feeCents: Number(d.fee_cents),
        status: d.status,
        seenAt: d.seen_at,
      }));

      // Pending withdrawals (requested/approved/sent)
      const wdQ = await pool.query(
        `
        SELECT withdraw_id, method, amount_cents, fee_cents, status, target_email, created_at
        FROM ff_withdrawal_request
        WHERE member_id=$1 AND status IN ('requested','approved','sent')
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [memberId]
      );
      const pendingWithdrawals = wdQ.rows.map((w) => ({
        withdrawId: Number(w.withdraw_id),
        method: w.method,
        amountCents: Number(w.amount_cents),
        feeCents: Number(w.fee_cents),
        status: w.status,
        targetEmail: w.target_email,
        createdAt: w.created_at,
      }));

      // Recent posted ledger (credits/debits)
      const recentQ = await pool.query(
        `
        SELECT ts, amount, kind, ref_type, ref_id
        FROM ff_ledger
        WHERE wallet_id=$1 AND status='posted'
        ORDER BY ts DESC
        LIMIT 50
        `,
        [walletId]
      );
      const recentActivity = recentQ.rows.map((r) => ({
        ts: r.ts,
        amount: Number(r.amount),
        kind: r.kind,
        ref: r.ref_type || r.ref_id ? { type: r.ref_type, id: r.ref_id } : null,
      }));

      // Available = posted - locked
      const balQ = await pool.query(
        `
        WITH posted AS (
          SELECT COALESCE(SUM(amount),0) AS posted
          FROM ff_ledger WHERE wallet_id=$1 AND status='posted'
        ),
        locked AS (
          SELECT COALESCE(SUM(amount),0) AS locked
          FROM ff_hold WHERE wallet_id=$1 AND status='active'
        )
        SELECT (SELECT posted FROM posted) AS posted,
               (SELECT locked FROM locked) AS locked
        `,
        [walletId]
      );
      const posted = Number(balQ.rows[0]?.posted || 0);
      const locked = Number(balQ.rows[0]?.locked || 0);

      return res.json({
        ok: true,
        available: posted - locked,
        locked: holds,
        pendingDeposits,
        pendingWithdrawals,
        recentActivity,
      });
    } catch (err) {
      console.error('GET /api/wallets/where error:', err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return router;
};
