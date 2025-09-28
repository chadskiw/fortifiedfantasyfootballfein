// routes/identity/verify-code.js
const express = require('express');
const pool    = require('../../src/db/pool');

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

router.post('/verify-code', async (req, res) => {
  try {
    const rawId = String(req.body?.identifier || '').trim();
    const code  = String(req.body?.code || '').trim();

    if (!rawId || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok:false, error:'bad_request' });
    }

    let identifier_kind, identifier_value, channel;
    if (EMAIL_RX.test(rawId.toLowerCase())) {
      identifier_kind  = 'email';
      identifier_value = rawId.toLowerCase();
      channel          = 'email';
    } else if (E164_RX.test(rawId)) {
      identifier_kind  = 'phone';
      identifier_value = rawId;
      channel          = 'sms';
    } else {
      return res.status(422).json({ ok:false, error:'invalid_identifier' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // lock the latest active code for this identifier/channel
      const { rows } = await client.query(
        `
        SELECT id, member_id, code, expires_at, attempts
          FROM ff_identity_code
         WHERE identifier_kind  = $1
           AND identifier_value = $2
           AND channel          = $3
           AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE
        `,
        [identifier_kind, identifier_value, channel]
      );

      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok:false, error:'code_not_found' });
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query('UPDATE ff_identity_code SET consumed_at = NOW() WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return res.status(400).json({ ok:false, error:'code_expired' });
      }

      if (row.code !== code) {
        await client.query('UPDATE ff_identity_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return res.status(400).json({ ok:false, error:'invalid_code' });
      }

      // good code → consume it
      await client.query('UPDATE ff_identity_code SET consumed_at = NOW() WHERE id = $1', [row.id]);

      // figure out which member to verify
      const candidateMember =
        (req.user && String(req.user.id)) ||
        (req.body?.member_id ? String(req.body.member_id) : null) ||
        (row.member_id ? String(row.member_id) : null) ||
        null;

      let finalMemberId = null;

      if (candidateMember) {
        const chk = await client.query(
          `SELECT member_id FROM ff_member WHERE member_id = $1 LIMIT 1`,
          [candidateMember]
        );
        finalMemberId = chk.rows[0]?.member_id || null;
      }

      if (!finalMemberId) {
        const byContact = await client.query(
          identifier_kind === 'email'
            ? `SELECT member_id FROM ff_member WHERE LOWER(email) = LOWER($1) LIMIT 1`
            : `SELECT member_id FROM ff_member WHERE phone = $1 LIMIT 1`,
          [identifier_value]
        );
        finalMemberId = byContact.rows[0]?.member_id || null;
      }

      if (finalMemberId) {
        if (identifier_kind === 'email') {
          await client.query(
            `
            UPDATE ff_member
               SET email = COALESCE(email, $2),
                   email_verified_at = NOW()
             WHERE member_id = $1
            `,
            [finalMemberId, identifier_value]
          );
        } else {
          await client.query(
            `
            UPDATE ff_member
               SET phone = COALESCE(phone, $2),
                   phone_verified_at = NOW()
             WHERE member_id = $1
            `,
            [finalMemberId, identifier_value]
          );
        }
      }

      await client.query('COMMIT');
      return res.json({ ok:true, verified: identifier_kind, channel, member_id: finalMemberId || null });
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
