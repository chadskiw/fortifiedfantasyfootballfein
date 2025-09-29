// routes/identity/verify-code.js
const express = require('express');
const router  = express.Router();
router.use(express.json());

/* ---------- DB pool ---------- */
let db = require('../../src/db/pool'); // adjust if your pool path differs
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

/* ---------- helpers ---------- */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE_RE  = /^\d{6}$/;

function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}
function classifyIdentifier(id) {
  const e = normEmail(id);
  if (e) return { kind: 'email', value: e, channel: 'email' };
  const p = toE164(id);
  if (p) return { kind: 'phone', value: p, channel: 'sms' };
  return { kind: null, value: null, channel: null };
}

async function resolveMemberId({ member_id, kind, value }) {
  if (member_id) return member_id;

  if (kind === 'email') {
    const q = `
      SELECT member_id FROM (
        SELECT member_id FROM ff_member      WHERE LOWER(email)=LOWER($1)
        UNION ALL
        SELECT member_id FROM ff_quickhitter WHERE LOWER(email)=LOWER($1)
      ) t WHERE member_id IS NOT NULL LIMIT 1
    `;
    const { rows } = await pool.query(q, [value]);
    return rows[0]?.member_id || null;
  }
  if (kind === 'phone') {
    const q = `
      SELECT member_id FROM (
        SELECT member_id FROM ff_member      WHERE phone_e164=$1
        UNION ALL
        SELECT member_id FROM ff_quickhitter WHERE phone=$1
      ) t WHERE member_id IS NOT NULL LIMIT 1
    `;
    const { rows } = await pool.query(q, [value]);
    return rows[0]?.member_id || null;
  }
  return null;
}

/* ---------- POST /api/identity/verify-code ---------- */
router.post('/verify-code', async (req, res) => {
  const rawIdentifier = String(req.body?.identifier || '').trim();
  const rawCode       = String(req.body?.code || '').trim();

  if (!CODE_RE.test(rawCode)) {
    return res.status(400).json({ ok: false, error: 'bad_code', message: 'Enter the 6-digit code.' });
  }

  const id = classifyIdentifier(rawIdentifier);
  if (!id.value) {
    return res.status(400).json({ ok: false, error: 'bad_identifier', message: 'Email or E.164 phone required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Grab the most recent active code for this (kind,value,channel)
    const sel = `
      SELECT id, member_id, identifier_kind, identifier_value, channel, code, attempts,
             expires_at, created_at, consumed_at, is_active
      FROM ff_identity_code
      WHERE identifier_kind = $1
        AND identifier_value = $2
        AND channel = $3
        AND consumed_at IS NULL
        AND is_active = TRUE
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const { rows } = await client.query(sel, [id.kind, id.value, id.channel]);
    const row = rows[0] || null;

    if (!row) {
      await client.query('COMMIT');
      return res.status(400).json({ ok: false, error: 'no_active_code', message: 'Invalid or expired code.' });
    }

    if (String(row.code) !== rawCode) {
      await client.query('UPDATE ff_identity_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return res.status(400).json({ ok: false, error: 'mismatch', message: 'Invalid or expired code.' });
    }

    // Mark consumed
    await client.query(
      `UPDATE ff_identity_code
         SET consumed_at = now(), is_active = FALSE
       WHERE id = $1`,
      [row.id]
    );

    // Figure out who owns this contact (favor code.member_id; otherwise lookup)
    const memberId = await resolveMemberId({ member_id: row.member_id, kind: id.kind, value: id.value });

    // Reflect verification into ff_quickhitter (for this member or this contact)
    if (id.kind === 'email') {
      if (memberId) {
        await client.query(
          `UPDATE ff_quickhitter
              SET email = COALESCE(email, $2),
                  email_is_verified = TRUE,
                  updated_at = now()
            WHERE member_id = $1`,
          [memberId, id.value]
        );
      } else {
        await client.query(
          `UPDATE ff_quickhitter
              SET email_is_verified = TRUE, updated_at = now()
            WHERE LOWER(email) = LOWER($1)`,
          [id.value]
        );
      }
      // Mirror to ff_member if we can
      if (memberId) {
        await client.query(
          `UPDATE ff_member
              SET email = COALESCE(email, $2),
                  email_verified_at = COALESCE(email_verified_at, now()),
                  updated_at = now()
            WHERE member_id = $1`,
          [memberId, id.value]
        );
      }
    } else {
      // phone
      if (memberId) {
        await client.query(
          `UPDATE ff_quickhitter
              SET phone = COALESCE(phone, $2),
                  phone_is_verified = TRUE,
                  updated_at = now()
            WHERE member_id = $1`,
          [memberId, id.value]
        );
      } else {
        await client.query(
          `UPDATE ff_quickhitter
              SET phone_is_verified = TRUE, updated_at = now()
            WHERE phone = $1`,
          [id.value]
        );
      }
      if (memberId) {
        await client.query(
          `UPDATE ff_member
              SET phone_e164 = COALESCE(phone_e164, $2),
                  phone_verified_at = COALESCE(phone_verified_at, now()),
                  updated_at = now()
            WHERE member_id = $1`,
          [memberId, id.value]
        );
      }
    }

    await client.query('COMMIT');

    // Keep the cookie the same; whoami can re-hydrate
    return res.json({ ok: true, member_id: memberId || null, kind: id.kind, value: id.value });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[identity/verify-code] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;
