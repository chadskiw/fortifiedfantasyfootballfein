// routes/identity/request-code.js
const express = require('express');
const pool    = require('../../src/db/pool');
const notify  = require('../../services/notify'); // sendOne() — best-effort shim

const router = express.Router();
router.use(express.json());

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RX  = /^\+[1-9]\d{7,14}$/;

function six() {
  // 000000–999999 as zero-padded string
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

router.post('/request-code', async (req, res) => {
  try {
    const rawId = String(req.body?.identifier || '').trim();
    if (!rawId) return res.status(400).json({ ok:false, error:'missing_identifier' });

    // normalize → kind/value/channel
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

    // who are we sending this for (optional)
    const memberHint =
      (req.user && String(req.user.id)) ||
      (req.body?.member_id ? String(req.body.member_id) : null) ||
      null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Look for an existing active code (same kind/value/channel) — reuse if present
      const { rows: existing } = await client.query(
        `
        SELECT id, code, expires_at
          FROM ff_identity_code
         WHERE identifier_kind  = $1
           AND identifier_value = $2
           AND channel          = $3
           AND consumed_at IS NULL
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1
        `,
        [identifier_kind, identifier_value, channel]
      );

      let code, expiresAt;
      let reused = false;

      if (existing.length) {
        // Reuse the most recent active code
        code = existing[0].code;
        expiresAt = existing[0].expires_at;
        reused = true;

        // Optional: gently “refresh” expiry window by extending if < 5 min left
        // (safe because we’re not violating the unique index; we’re not INSERTing)
        const msLeft = new Date(expiresAt).getTime() - Date.now();
        if (msLeft < 5 * 60_000) {
          const { rows: r2 } = await client.query(
            `UPDATE ff_identity_code
                SET expires_at = NOW() + interval '10 minutes'
              WHERE id = $1
            RETURNING expires_at`,
            [existing[0].id]
          );
          expiresAt = r2[0].expires_at;
        }
      } else {
        // 2) Create a new code
        code = six();
        const { rows: ins } = await client.query(
          `
          INSERT INTO ff_identity_code
            (member_id, identifier_kind, identifier_value, channel, code, expires_at)
          VALUES
            ($1,        $2,              $3,               $4,      $5,   NOW() + interval '10 minutes')
          RETURNING expires_at
          `,
          [memberHint, identifier_kind, identifier_value, channel, code]
        );
        expiresAt = ins[0].expires_at;
      }

      await client.query('COMMIT');

      // 3) Fire-and-forget notification (never throws; only warns if creds missing)
      //    Template IDs: email → emailDefault, sms → smsDefault (in your shim) :contentReference[oaicite:1]{index=1}
      notify.sendOne({
        channel,
        to: identifier_value,
        data: { code },
        // If you created specific templates, uncomment:
        // templateId: channel === 'sms' ? 'smsDefault' : 'emailDefault'
      });

      // 4) Done
      return res.json({
        ok: true,
        reused,
        channel,
        identifier: identifier_value,
        expiresAt
      });
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error('[identity/request-code] db error:', e);
      return res.status(500).json({ ok:false, error:'db_error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[identity/request-code] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
