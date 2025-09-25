// src/routes/members.js
const express = require('express');
const router  = express.Router();

let pool = require('../db/pool');
if (pool && pool.pool && typeof pool.pool.query === 'function') pool = pool.pool;

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;

const normPhone  = p => {
  const s = String(p||'').trim(); if (!PHONE_RE.test(s)) return null;
  const d = s.replace(/[^\d]/g,'');
  return d.length === 10 ? `+1${d}` : (d.length===11 && d.startsWith('1') ? `+${d}` : `+${d}`);
};

router.get('/lookup', async (req,res) => {
  try{
    const q = String(req.query.identifier || '').trim();
    if (!q) return res.status(422).json({ ok:false, error:'missing_identifier' });

    let rows = [];
    if (EMAIL_RE.test(q)) {
      const e = q.toLowerCase();
      rows = (await pool.query(`
        SELECT 'member' src, member_id, username, email, phone_e164 AS phone, color_hex
          FROM ff_member WHERE LOWER(email)=$1
        UNION ALL
        SELECT 'quickhitter' src, member_id, handle AS username, email, phone, color_hex
          FROM ff_quickhitter WHERE LOWER(email)=$1
        LIMIT 5
      `, [e])).rows;
    } else if (PHONE_RE.test(q)) {
      const p = normPhone(q);
      rows = (await pool.query(`
        SELECT 'member' src, member_id, username, email, phone_e164 AS phone, color_hex
          FROM ff_member WHERE phone_e164=$1
        UNION ALL
        SELECT 'quickhitter' src, member_id, handle AS username, email, phone, color_hex
          FROM ff_quickhitter WHERE phone=$1
        LIMIT 5
      `, [p])).rows;
    } else {
      // assume handle
      rows = (await pool.query(`
        SELECT 'member' src, member_id, username, email, phone_e164 AS phone, color_hex
          FROM ff_member WHERE LOWER(username)=LOWER($1)
        UNION ALL
        SELECT 'quickhitter' src, member_id, handle AS username, email, phone, color_hex
          FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1)
        LIMIT 5
      `, [q])).rows;
    }

    res.set('Cache-Control','no-store');
    res.json({ ok:true, results: rows });
  } catch (e) {
    console.error('[members/lookup]', e);
    res.status(500).json({ ok:false, error:'internal_error' });
  }
});

module.exports = router;
