// routes/identity/verify-code.js
const express = require('express');
const pool    = require('../../src/db/pool');

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

router.post('/verify-code', async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || '').trim();
    const code       = String(req.body?.code || '').trim();

    if (!identifier || !/^\d{6}$/.test(code))
      return res.status(400).json({ ok:false, error:'bad_request' });

    // normalize
    let kind, value;
    if (EMAIL_RX.test(identifier.toLowerCase())) {
      kind = 'email';
      value = identifier.toLowerCase();
    } else if (E164_RX.test(identifier)) {
      kind = 'phone';
      value = identifier;
    } else {
      return res.status(422).json({ ok:false, error:'invalid_identifier' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // lock latest matching active code
      const { rows } = await client.query(
        `
        SELECT id, member_id
          FROM ff_identity_code
         WHERE identifier_kind = $1
           AND identifier_value = $2
           AND code = $3
           AND consumed_at IS NULL
           AND expires_at > NOW()
         ORDER BY id DESC
         FOR UPDATE
        `,
        [kind, value, code]
      );

      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok:false, error:'invalid_or_expired' });
      }

      const row = rows[0];

      // consume the code
      await client.query(
        `UPDATE ff_identity_code SET consumed_at = NOW() WHERE id = $1`,
        [row.id]
      );

      // choose member to apply verification to
      const sessionMember =
        (req.user && req.user.id) ||
        (req.body?.member_id) ||
        (req.query?.member_id) ||
        row.member_id ||
        null;

      let finalMember = null;

      if (sessionMember) {
        const r = await client.query(
          'SELECT member_id FROM ff_member WHERE member_id = $1',
          [String(sessionMember)]
        );
        finalMember = r.rows[0]?.member_id || null;
      }

      if (!finalMember) {
        // try to locate by contact itself
        const byContact = await client.query(
          kind === 'email'
            ? 'SELECT member_id FROM ff_member WHERE LOWER(email) = LOWER($1) LIMIT 1'
            : 'SELECT member_id FROM ff_member WHERE phone_e164 = $1 LIMIT 1',
          [value]
        );
        finalMember = byContact.rows[0]?.member_id || null;
      }

      if (finalMember) {
        if (kind === 'email') {
          await client.query(
            `
            UPDATE ff_member
               SET email = COALESCE(email, $2),
                   email_verified_at = NOW(),
                   updated_at = NOW()
             WHERE member_id = $1
            `,
            [finalMember, value]
          );
        } else {
          await client.query(
            `
            UPDATE ff_member
               SET phone_e164 = COALESCE(phone_e164, $2),
                   phone_verified_at = NOW(),
                   updated_at = NOW()
             WHERE member_id = $1
            `,
            [finalMember, value]
          );
        }
      }

      await client.query('COMMIT');
      return res.json({ ok:true, verified: kind, member_id: finalMember || null });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[identity/verify-code] tx error:', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[identity/verify-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
