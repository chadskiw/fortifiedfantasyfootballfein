// routes/identity/verify-code.js
// Mount: app.use('/api/identity', require('./routes/identity/verify-code'));

const express = require('express');
const pool    = require('../../src/db/pool');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

router.post('/verify-code', async (req, res) => {
  try {
    const { identifier, code } = req.body || {};
    const val = String(identifier || '').trim();
    const kind = EMAIL_RE.test(val) ? 'email' : (E164_RE.test(val) ? 'phone' : null);
    if (!kind) return res.status(422).json({ ok:false, error:'invalid_identifier' });
    if (!/^\d{6}$/.test(String(code || ''))) return res.status(422).json({ ok:false, error:'invalid_code' });

    const channel = kind === 'email' ? 'email' : 'sms';
    const cookieMemberId = (req.cookies?.ff_member || '').trim() || null;

    // find active matching code
    const q = await pool.query(
      `
      SELECT id, member_id, code, identifier_value
        FROM ff_identity_code
       WHERE identifier_kind=$1
         AND identifier_value=$2
         AND channel=$3
         AND code=$4
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
      `,
      [kind, val, channel, String(code)]
    );
    if (!q.rowCount) {
      await pool.query(
        `UPDATE ff_identity_code
            SET attempts = attempts + 1
          WHERE identifier_kind=$1 AND identifier_value=$2 AND channel=$3
          ORDER BY created_at DESC
          LIMIT 1`,
        [kind, val, channel]
      ).catch(()=>{});
      return res.status(400).json({ ok:false, error:'invalid_or_expired' });
    }

    const row = q.rows[0];

    // consume
    await pool.query(`UPDATE ff_identity_code SET consumed_at = now() WHERE id=$1`, [row.id]);

    // choose member to attach
    const targetMember = row.member_id || cookieMemberId;
    if (!targetMember) return res.json({ ok:true, verified:true, attached:false });

    // mark verified in quickhitter
    if (kind === 'email') {
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, email, email_is_verified, created_at, updated_at)
        VALUES ($1, $2, true, now(), now())
        ON CONFLICT (member_id) DO UPDATE
        SET email=$2, email_is_verified=true, updated_at=now()
        `,
        [targetMember, row.identifier_value]
      );
    } else {
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, phone, phone_is_verified, created_at, updated_at)
        VALUES ($1, $2, true, now(), now())
        ON CONFLICT (member_id) DO UPDATE
        SET phone=$2, phone_is_verified=true, updated_at=now()
        `,
        [targetMember, row.identifier_value]
      );
    }

    // now that at least one contact is verified, promote (server-side SQL function)
    // NOTE: we delay promotion to ff_member until AFTER verification.
    await pool.query(`SELECT promote_qh_when_ready($1)`, [targetMember]).catch(e => {
      console.warn('[verify-code] promote warn:', e?.message || e);
    });

    return res.json({ ok:true, verified:true, attached:true, member_id: targetMember });
  } catch (err) {
    console.error('[identity/verify-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
