// src/routes/identity.js
const express = require('express');
const router  = express.Router();
router.use(express.json());

let db = require('../src/db/pool'); // adjust path to your pool
let pool = db.pool || db;

const { sendVerification, ensureE164, EMAIL_RE } = require('../services/notify');

// ---------- helpers ----------
const now = () => new Date();
const addMinutes = (d, m) => new Date(d.getTime() + m*60000);
const norm = v => String(v || '').trim();
function getMemberId(req){
  return (req.cookies && String(req.cookies.ff_member || '').trim()) || null;
}

// ---------- POST /api/identity/request-code ----------
router.post('/request-code', async (req, res) => {
  try{
    const member_id = getMemberId(req) || null;
    const raw = norm(req.body?.identifier);
    if (!raw) return res.status(400).json({ ok:false, error:'missing_identifier' });

    // normalize identifier
    const isEmail = EMAIL_RE.test(raw);
    const phoneE164 = ensureE164(raw);
    const identifier = isEmail ? raw.toLowerCase() : (phoneE164 || null);
    if (!identifier) return res.status(422).json({ ok:false, error:'bad_identifier', message:'Enter a valid email or E.164 phone.' });

    // Create a fresh code (6 digits), 10-min TTL
    const code = ('' + Math.floor(100000 + Math.random()*900000)).slice(-6);
    const expiresAt = addMinutes(now(), 10);

    // Stage it in DB (upsert by identifier)
    await pool.query(`
      INSERT INTO ff_identity_code (member_id, identifier, channel, code, attempts, expires_at)
      VALUES ($1, $2, $3, $4, 0, $5)
      ON CONFLICT (identifier) DO UPDATE SET
        member_id  = EXCLUDED.member_id,
        channel    = EXCLUDED.channel,
        code       = EXCLUDED.code,
        attempts   = 0,
        expires_at = EXCLUDED.expires_at
    `, [member_id || 'ANON', identifier, isEmail ? 'email' : 'sms', code, expiresAt]);

    // Ensure quickhitter has the contact (unverified)
    if (member_id) {
      await pool.query(`
        INSERT INTO ff_quickhitter (member_id, email, phone)
        VALUES ($1, ${isEmail ? '$2' : 'NULL'}, ${!isEmail ? '$2' : 'NULL'})
        ON CONFLICT (member_id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, ff_quickhitter.email),
          phone = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
          updated_at = now()
      `, [member_id, identifier]);
    }

    // Send via NotificationAPI
    const sent = await sendVerification({ identifier, code, expiresMin:10 });

    if (!sent.ok) {
      // Non-fatal: return 202 so UI can show a friendly message
      return res.status(202).json({
        ok:false,
        error:'delivery_unavailable',
        reason: sent.reason,
        message:
          sent.reason === 'sms_not_configured' ? 'SMS delivery is not configured.' :
          sent.reason === 'email_not_configured' ? 'Email delivery is not configured.' :
          sent.reason === 'bad_identifier' ? 'Enter a valid email or E.164 phone.' :
          'Delivery failed; try again later.'
      });
    }

    return res.json({ ok:true, channel: sent.channel });
  }catch(e){
    console.error('[identity.request-code] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- POST /api/identity/verify ----------
router.post('/verify', async (req, res) => {
  try{
    const rawId = norm(req.body?.identifier);
    const code  = norm(req.body?.code);
    if (!rawId || !code) return res.status(400).json({ ok:false, error:'bad_request' });

    const isEmail = EMAIL_RE.test(rawId);
    const phoneE164 = ensureE164(rawId);
    const identifier = isEmail ? rawId.toLowerCase() : (phoneE164 || null);
    if (!identifier) return res.status(422).json({ ok:false, error:'bad_identifier' });

    const { rows } = await pool.query(`
      SELECT id, member_id, channel, code, attempts, expires_at
      FROM ff_identity_code
      WHERE identifier=$1
      LIMIT 1
    `, [identifier]);
    const row = rows[0];
    if (!row) return res.status(404).json({ ok:false, error:'code_not_found' });

    if (now() > new Date(row.expires_at)) {
      return res.status(410).json({ ok:false, error:'code_expired' });
    }

    if (row.code !== code) {
      await pool.query(`UPDATE ff_identity_code SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
      return res.status(401).json({ ok:false, error:'code_mismatch' });
    }

    // Success → mark verified on quickhitter
    if (isEmail) {
      await pool.query(`
        UPDATE ff_quickhitter
           SET email = COALESCE($1, email),
               email_is_verified = TRUE,
               updated_at = now()
         WHERE COALESCE(member_id,'') <> ''
           AND (LOWER(email)=LOWER($1) OR member_id = $2)
      `,[identifier, row.member_id]);
    } else {
      await pool.query(`
        UPDATE ff_quickhitter
           SET phone = COALESCE($1, phone),
               phone_is_verified = TRUE,
               updated_at = now()
         WHERE COALESCE(member_id,'') <> ''
           AND (phone=$1 OR member_id = $2)
      `,[identifier, row.member_id]);
    }

    // (optional) delete used code
    await pool.query(`DELETE FROM ff_identity_code WHERE id=$1`, [row.id]);

    return res.json({ ok:true, verified:true, channel: row.channel });
  }catch(e){
    console.error('[identity.verify] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
