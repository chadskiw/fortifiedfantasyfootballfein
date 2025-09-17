// server/routes/auth.js
const express = require('express');
const router = express.Router();

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// (optional) preflight so browsers don't 405 on OPTIONS
router.options('/contact-lookup', (_req, res) => res.sendStatus(204));

// helpers
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').trim());
const isE164  = s => /^\+[1-9]\d{7,14}$/.test(String(s||'').trim());

// POST /api/auth/contact-lookup
router.post('/contact-lookup', async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    if (!email && !phone) return res.status(400).json({ ok:false, error:'email or phone required' });

    // normalize
    const qEmail = email && isEmail(email) ? email.toLowerCase() : null;
    const qPhone = phone && isE164(phone)  ? phone : null;

    // TODO: replace with your real DB check
    const exists = await req.app.locals.dbHasUser?.(qEmail, qPhone) ?? false;

    return res.json({ ok:true, exists });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// (you’ll also want these later)
router.post('/contact-init', async (req, res) => { /* send keys, set ff_sig8 */ return res.json({ ok:true, sent:true }); });
router.post('/verify-login', async (req, res) => { /* check loginKey */ return res.json({ ok:true, redirect:'/fein' }); });

module.exports = router;
