// routes/identity/verify-code.js
// Mount with: app.use('/api/identity', require('./routes/identity/verify-code'));

const express = require('express');
const pool    = require('../../src/db/pool');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/;

router.post('/verify-code', async (req, res) => {
  try {
    const { identifier, code } = req.body || {};
    const raw = String(identifier || '').trim();
    const isEmail = EMAIL_RE.test(raw);
    const isPhone = E164_RE.test(raw);
    if (!(isEmail || isPhone)) {
      return res.status(422).json({ ok:false, error:'invalid_identifier' });
    }
    if (!/^\d{6}$/.test(String(code || ''))) {
      return res.status(422).json({ ok:false, error:'invalid_code' });
    }

    const kind    = isEmail ? 'email' : 'phone';
    const channel = isEmail ? 'email' : 'sms';
    const cookieMemberId = (req.cookies?.ff_member || '').trim() || null;

    // Find an active (not consumed, unexpired) row with this exact code+identifier
    const q = await pool.query(
      `
      SELECT id, member_id, identifier_kind, identifier_value, channel, code, attempts,
             expires_at, created_at, consumed_at
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
      [kind, raw, channel, String(code)]
    );

    if (!q.rowCount) {
      // increment attempts if there is a most recent matching identifier/code (optional)
      await pool.query(
        `UPDATE ff_identity_code
            SET attempts = attempts + 1
          WHERE identifier_kind=$1 AND identifier_value=$2 AND channel=$3
          ORDER BY created_at DESC
          LIMIT 1`,
        [kind, raw, channel]
      ).catch(()=>{});
      return res.status(400).json({ ok:false, error:'invalid_or_expired' });
    }

    const row = q.rows[0];

    // Mark consumed
    await pool.query(
      `UPDATE ff_identity_code SET consumed_at = now() WHERE id=$1`,
      [row.id]
    );

    // Decide which member gets the verified contact:
    //   Prefer the member_id stored on the code row; else fall back to current cookie.
    const targetMember = row.member_id || cookieMemberId;
    if (!targetMember) {
      // Edge: no member to attach to (should be rare). We still succeed.
      return res.json({ ok:true, verified:true, attached:false });
    }

    // Apply to ff_quickhitter
    if (kind === 'email') {
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, email, email_is_verified, updated_at, created_at)
        VALUES ($1, $2, true, now(), now())
        ON CONFLICT (member_id) DO UPDATE
        SET email=$2, email_is_verified=true, updated_at=now()
        `,
        [targetMember, row.identifier_value]
      );
    } else {
      await pool.query(
        `
        INSERT INTO ff_quickhitter (member_id, phone, phone_is_verified, updated_at, created_at)
        VALUES ($1, $2, true, now(), now())
        ON CONFLICT (member_id) DO UPDATE
        SET phone=$2, phone_is_verified=true, updated_at=now()
        `,
        [targetMember, row.identifier_value]
      );
    }

    return res.json({ ok:true, verified:true, attached:true, member_id: targetMember });

  } catch (err) {
    console.error('[identity/verify-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
