// routes/identity/resolve.js
const express = require('express');
const { createOption } = require('./store');

const router  = express.Router();
router.use(express.json());

const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  return d ? `${u.slice(0, 2)}…@${d}` : '';
};
const maskPhone = (p) => {
  const t = String(p || '').replace(/[^\d]/g, '');
  return t.length >= 4 ? `••• ••${t.slice(-4)}` : '';
};

const classify = (v) => {
  if (!v) return { kind: 'null' };
  const s = String(v).trim();
  const isEmail  = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  const isPhone  = /^\+?[0-9][0-9\s\-().]{5,}$/.test(s);
  const isHandle = /^[A-Za-z0-9_.]{3,24}$/.test(s);
  if (isEmail)  return { kind:'email',  value:s.toLowerCase() };
  if (isPhone)  {
    let t = s.replace(/[^\d+]/g,'');
    if (t && !t.startsWith('+') && t.length === 10) t = '+1'+t;
    return { kind:'phone', value:t };
  }
  if (isHandle) return { kind:'handle', value:s };
  return { kind:'bad' };
};

// POST /api/signin/resolve  { handle }
router.post('/resolve', async (req, res) => {
  try {
    const input = (req.body && (req.body.handle ?? req.body.identifier)) || '';
    const { kind, value } = classify(input);

    // Only handles show the chooser; others return empty (no 4xx)
    if (kind !== 'handle') return res.json({ ok:true, candidates: [] });

    const pool = req.app.get('pg'); // set in server.js: app.set('pg', pool)
    const { rows } = await pool.query(`
      SELECT member_id, handle, color_hex, image_key,
             email, email_is_verified,
             phone, phone_is_verified,
             (quick_snap IS NOT NULL AND quick_snap <> '') AS espn
        FROM ff_quickhitter
       WHERE LOWER(handle) = LOWER($1)
    `, [value]);

    const candidates = rows.map(r => {
      const options = [];

      if (r.email && (String(r.email_is_verified).toLowerCase().startsWith('t') || r.email_is_verified === true)) {
        const option_id = createOption({ member_id: r.member_id, kind: 'email', identifier: r.email.toLowerCase() });
        options.push({ kind:'email', hint:maskEmail(r.email), option_id });
      }
      if (r.phone && (String(r.phone_is_verified).toLowerCase().startsWith('t') || r.phone_is_verified === true)) {
        const option_id = createOption({ member_id: r.member_id, kind: 'phone', identifier: r.phone });
        options.push({ kind:'sms', hint:maskPhone(r.phone), option_id });
      }

      return {
        display: {
          handle: r.handle,
          color: r.color_hex || '#77E0FF',
          image_key: r.image_key || null,
          espn: !!r.espn
        },
        options
      };
    });

    return res.json({ ok:true, candidates });
  } catch (e) {
    console.error('[signin/resolve] error', e);
    return res.status(200).json({ ok:true, candidates: [] }); // never 4xx here
  }
});

module.exports = router;
