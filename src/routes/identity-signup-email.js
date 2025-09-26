const express = require('express');
const router  = express.Router();
router.use(express.json());

const db = require('../db/pool');               // adjust if your pool lives elsewhere
const pool = db.pool || db;

// very light email/phone classifiers
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const asPhone  = v => {
  let t = String(v || '').replace(/[^\d+]/g, '');
  if (t && !t.startsWith('+') && t.length === 10) t = '+1' + t;
  return t || null;
};

// shape row → minimal member object
const rowToMember = (r) => !r ? null : ({
  member_id: r.member_id,
  handle: r.handle || null,
  color_hex: r.color_hex ? (String(r.color_hex).startsWith('#') ? r.color_hex : ('#' + r.color_hex)) : null,
  image_key: r.image_key || null,
  email: r.email || null,
  phone: r.phone || null,
  email_is_verified: !!r.email_is_verified,
  phone_is_verified: !!r.phone_is_verified,
});

// POST /api/identity/signup
// body: { identifier: string, code: string }
// NOTE: This marks the identifier verified for the current ff_member cookie.
//       Wire to your real code-store later; this just prevents 404s and unblocks flow.
router.post('/signup', async (req, res) => {
  try {
    const { identifier, code } = req.body || {};
    const memberId = req.cookies?.ff_member;
    if (!memberId) return res.status(401).json({ ok:false, error:'no_member' });
    if (!identifier) return res.status(400).json({ ok:false, error:'missing_identifier' });

    const isEmail = EMAIL_RE.test(identifier);
    const phone   = isEmail ? null : asPhone(identifier);
    const email   = isEmail ? String(identifier).toLowerCase() : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'bad_identifier' });

    // TODO: replace with real code verification lookup:
    if (!code || String(code).length < 4) {
      // Nod back but don’t mark verified if there’s obviously no code.
      return res.status(400).json({ ok:false, error:'missing_or_bad_code' });
    }

    const sql = `
      UPDATE ff_quickhitter
         SET email = COALESCE($2, email),
             phone = COALESCE($3, phone),
             email_is_verified = email_is_verified OR $4,
             phone_is_verified = phone_is_verified OR $5,
             updated_at = NOW()
       WHERE member_id = $1
       RETURNING *;
    `;
    const params = [memberId, email, phone, !!email, !!phone];
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ ok:false, error:'not_found' });

    const m = rowToMember(rows[0]);
    // refresh cookie life
    res.cookie('ff_member', m.member_id, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });

    return res.json({ ok:true, verified:true, member:m });
  } catch (e) {
    console.error('[identity.signup]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
