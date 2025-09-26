// routes/identity/request-code.js
const express = require('express');
const router = express.Router();
const notificationapi = require('../../lib/notifier'); // path to the file above
const crypto = require('crypto');
const pool = require('../../src/db/pool'); // adjust path

function genCode() {
  // 6-digit numeric
  return ('' + Math.floor(100000 + Math.random() * 900000));
}

router.post('/request-code', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ ok:false, error:'missing_identifier' });

    // normalize identifier
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier);
    const isPhone = /^\+?[0-9][0-9\s\-().]{5,}$/.test(identifier);
    const phoneE164 = isPhone
      ? (identifier.replace(/[^\d+]/g,'').replace(/^(\d{10})$/, '+1$1'))
      : null;

    if (!isEmail && !phoneE164) {
      return res.status(400).json({ ok:false, error:'bad_identifier' });
    }

    // create code + expiry and persist it to your table (ff_member or a login_codes table)
    const code = genCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // upsert a row for this identifier (simplified; adapt to your schema)
    await pool.query(`
      INSERT INTO ff_member (member_id, email, phone_e164, login_code, login_code_expires)
      VALUES (
        COALESCE((SELECT member_id FROM ff_member WHERE ${isEmail ? 'LOWER(email)=LOWER($1)' : 'phone_e164=$2'} LIMIT 1),
                 encode(digest($3,'sha256'),'hex')::text),  -- synthetic member_id seed if new
        $1, $2, $4, $5
      )
      ON CONFLICT (member_id) DO UPDATE
        SET login_code=$4, login_code_expires=$5,
            email = COALESCE(ff_member.email, $1),
            phone_e164 = COALESCE(ff_member.phone_e164, $2)
    `, [isEmail ? identifier.toLowerCase() : null, phoneE164, (identifier || '') + Date.now(), code, expiresAt]);

    // send via NotificationAPI (template IDs must exist in your dashboard)
    // Example uses a single template "login_code" that can branch by channel.
    if (notificationapi && notificationapi.send) {
      await notificationapi.send({
        type: 'login_code', // <-- your template id
        to: {
          id: (isEmail ? `email:${identifier.toLowerCase()}` : `phone:${phoneE164}`),
          email: isEmail ? identifier.toLowerCase() : undefined,
          number: phoneE164 || undefined
        },
        parameters: {
          code,
          expiresInMins: 10
        }
      });
    } else {
      console.warn('[request-code] notificationapi not initialized; skipping send');
    }

    res.json({ ok:true, sent:true });
  } catch (e) {
    console.error('[request-code] error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
