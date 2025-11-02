// routes/identity/verify-code.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
router.use(express.json());

let db = require('../../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

const { consumeChallenge } = require('./store');

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

function clientUserAgent(req){ return String(req.headers['user-agent'] || '').slice(0, 1024); }
function clientIP(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '').replace(/^::ffff:/, '');
}
function sha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/** ensureSession
 * - Requires a non-null member_id
 * - Inserts a new ff_session row if none exists for (member_id, ip_hash, user_agent)
 * - Returns { session_id }
 * - Sets cookies: ff_member_id, ff_session_id, ff_logged_in=1
 */
async function ensureSession(member_id, req, res){
  if (!member_id) return null;

  const ua = clientUserAgent(req);
  const ip = clientIP(req);
  const ip_hash = sha256(ip);

  // Try existing exact-fingerprint session
  const sel = `
    SELECT session_id
      FROM ff_session
     WHERE member_id = $1
       AND ip_hash   = $2
       AND user_agent = $3
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const { rows } = await pool.query(sel, [member_id, ip_hash, ua]);

  let session_id = rows[0]?.session_id;

  if (!session_id) {
    // Insert new; session_id default should generate UUID (see SQL at end)
    const ins = `
      INSERT INTO ff_session (member_id, created_at, last_seen_at, ip_hash, user_agent)
      VALUES ($1, now(), now(), $2, $3)
      RETURNING session_id
    `;
    const insRes = await pool.query(ins, [member_id, ip_hash, ua]);
    session_id = insRes.rows[0].session_id;
  } else {
    // Touch last_seen_at
    await pool.query(`UPDATE ff_session SET last_seen_at = now() WHERE session_id = $1`, [session_id]);
  }

  // Set cookies exactly as /api/identity/me expects
  const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  const base = { sameSite:'Lax', secure:true, path:'/', maxAge };

  res.cookie('ff_member_id', String(member_id), { ...base, httpOnly:true });
  res.cookie('ff_session_id', String(session_id), { ...base, httpOnly:true });
  // readable flag for client UX
  res.cookie('ff_logged_in', '1', { ...base, httpOnly:false });

  return { session_id };
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

// ================== ROUTE ==================
router.post('/verify-code', async (req, res) => {
  const rawCode = String(req.body?.code || '').trim();

  if (!CODE_RE.test(rawCode)) {
    return res.status(400).json({ ok: false, error: 'bad_code', message: 'Enter the 6-digit code.' });
  }

  // ---------- Opaque challenge path ----------
  if (req.body?.challenge_id) {
    const out = consumeChallenge(String(req.body.challenge_id), rawCode);
    if (!out.ok) return res.status(401).json({ ok:false, error: out.error });

    const { member_id, identifier, channel } = out.data;
    const kind = channel === 'email' ? 'email' : 'phone';
    const value = identifier;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (kind === 'email') {
        await client.query(
          `UPDATE ff_quickhitter
              SET email = COALESCE(email, $2),
                  email_is_verified = t,
                  updated_at = now()
            WHERE member_id = $1 OR LOWER(email) = LOWER($2)`,
          [member_id, value]
        );
        if (member_id) {
          await client.query(
            `UPDATE ff_member
                SET email = COALESCE(email, $2),
                    email_verified_at = COALESCE(email_verified_at, now()),
                    updated_at = now()
              WHERE member_id = $1`,
            [member_id, value]
          );
        }
      } else {
        await client.query(
          `UPDATE ff_quickhitter
              SET phone = COALESCE(phone, $2),
                  phone_is_verified = t,
                  updated_at = now()
            WHERE member_id = $1 OR phone = $2`,
          [member_id, value]
        );
        if (member_id) {
          await client.query(
            `UPDATE ff_member
                SET phone_e164 = COALESCE(phone_e164, $2),
                    phone_verified_at = COALESCE(phone_verified_at, now()),
                    updated_at = now()
              WHERE member_id = $1`,
            [member_id, value]
          );
        }
      }

      // Ensure session + cookies
      const resolvedMemberId = member_id || await resolveMemberId({ member_id, kind, value });
      if (resolvedMemberId) {
        await ensureSession(resolvedMemberId, req, res);
      }

      await client.query('COMMIT');
      return res.json({ ok:true, member_id: resolvedMemberId || null, kind, value });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('[identity/verify-code opaque] error:', err);
      return res.status(500).json({ ok:false, error:'server_error' });
    } finally {
      client.release();
    }
  }

  // ---------- Legacy identifier path ----------
  const rawIdentifier = String(req.body?.identifier || '').trim();
  const id = classifyIdentifier(rawIdentifier);
  if (!id.value) {
    return res.status(400).json({ ok: false, error: 'bad_identifier', message: 'Email or E.164 phone required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    if (!row || String(row.code) !== rawCode) {
      if (row) await client.query('UPDATE ff_identity_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return res.status(400).json({ ok: false, error: 'mismatch', message: 'Invalid or expired code.' });
    }

    await client.query(
      `UPDATE ff_identity_code
         SET consumed_at = now(), is_active = FALSE
       WHERE id = $1`,
      [row.id]
    );

    const memberId = await resolveMemberId({ member_id: row.member_id, kind: id.kind, value: id.value });

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
        await client.query(
          `UPDATE ff_member
              SET email = COALESCE(email, $2),
                  email_verified_at = COALESCE(email_verified_at, now()),
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
    } else {
      if (memberId) {
        await client.query(
          `UPDATE ff_quickhitter
              SET phone = COALESCE(phone, $2),
                  phone_is_verified = TRUE,
                  updated_at = now()
            WHERE member_id = $1`,
          [memberId, id.value]
        );
        await client.query(
          `UPDATE ff_member
              SET phone_e164 = COALESCE(phone_e164, $2),
                  phone_verified_at = COALESCE(phone_verified_at, now()),
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
    }

    // Ensure session + cookies
    if (memberId) {
      await ensureSession(memberId, req, res);
    }

    await client.query('COMMIT');
    return res.json({ ok:true, member_id: memberId || null, kind: id.kind, value: id.value });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[identity/verify-code legacy] error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;
