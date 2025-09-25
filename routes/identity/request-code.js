// routes/identity/request-code.js
const express = require('express');
const router = express.Router();
const { pool } = require('../../src/db/pool'); // adjust path
const { setLoginCode } = require('../../lib/otp');
const { sendVerifyCode } = require('../../lib/notifier');

const isEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v||'').trim());
const normPhone = v => {
  let t = (v||'').replace(/[^\d+]/g, '');
  if (t && !t.startsWith('+') && t.length === 10) t = '+1' + t;
  return t;
};

router.post('/request-code', async (req, res) => {
  try {
    const raw = String(req.body?.identifier || '').trim();
    if (!raw) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const identifier = isEmail(raw) ? raw.toLowerCase() : normPhone(raw);
    const channel = isEmail(raw) ? 'email' : 'sms';

    // 1) locate or create a member_id (prefer ff_member; fallback to quickhitter)
    let memberId = null;

    // ff_member by email/phone
    if (isEmail(identifier)) {
      const r = await pool.query(`SELECT member_id FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`, [identifier]);
      memberId = r.rows[0]?.member_id || null;
    } else {
      const r = await pool.query(`SELECT member_id FROM ff_member WHERE phone_e164=$1 LIMIT 1`, [identifier]);
      memberId = r.rows[0]?.member_id || null;
    }

    // fallback: ff_quickhitter
    if (!memberId) {
      const r = isEmail(identifier)
        ? await pool.query(`SELECT member_id FROM ff_quickhitter WHERE LOWER(email)=LOWER($1) LIMIT 1`, [identifier])
        : await pool.query(`SELECT member_id FROM ff_quickhitter WHERE phone=$1 LIMIT 1`, [identifier]);

      memberId = r.rows[0]?.member_id || null;
    }

    // create bare member if still missing
    if (!memberId) {
      const newId = crypto.randomUUID().slice(0,8).toUpperCase();
      if (isEmail(identifier)) {
        await pool.query(`INSERT INTO ff_member (member_id, email, first_seen_at, last_seen_at)
                          VALUES ($1,$2,NOW(),NOW())`, [newId, identifier]);
      } else {
        await pool.query(`INSERT INTO ff_member (member_id, phone_e164, first_seen_at, last_seen_at)
                          VALUES ($1,$2,NOW(),NOW())`, [newId, identifier]);
      }
      memberId = newId;
    }

    // Refresh ff_member cookie for the browser
    res.cookie('ff_member', memberId, { httpOnly:true, sameSite:'Lax', secure:true, maxAge: 365*24*3600*1000 });

    // 2) create OTP (10 min) and return immediately
    const { code, expiresAt } = await setLoginCode(memberId, 10);

    // 3) KICK OFF the send (don’t await -> prevents 524s)
    sendVerifyCode({ to: identifier, code, channel, ttlMinutes:10 })
      .catch(err => console.error('[notify.sendVerifyCode]', err));

    // 4) respond fast
    return res.json({
      ok: true,
      member_id: memberId,
      via: channel,
      ttlSeconds: 600,
      // Optional: for debug only (never in prod) include code
      // code
    });
  } catch (e) {
    console.error('[identity.request-code]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
