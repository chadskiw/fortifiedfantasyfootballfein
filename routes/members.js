// src/api/members.js
const express = require('express');
const router = express.Router();
router.use(express.json());

let db = require('../src/db/pool');
let pool = db.pool || db;

function cookieMemberId(req){
  return (req.cookies && String(req.cookies.ff_member || '').trim()) || null;
}

// POST /api/members/upsert
router.post('/upsert', async (req, res) => {
  try{
    const member_id = cookieMemberId(req) || (req.body && req.body.member_id);
    if (!member_id) return res.status(401).json({ ok:false, error:'not_authenticated' });

    // IMPORTANT GUARD: only allow upsert if a verified contact exists in quickhitter OR member
    const ver = await pool.query(`
      SELECT
        COALESCE( (email_verified_at IS NOT NULL), false ) AS ev,
        COALESCE( (phone_verified_at IS NOT NULL), false ) AS pv
      FROM ff_member
      WHERE member_id = $1 AND deleted_at IS NULL
      UNION ALL
      SELECT
        COALESCE(email_is_verified, false) AS ev,
        COALESCE(phone_is_verified, false) AS pv
      FROM ff_quickhitter
      WHERE member_id = $1
      LIMIT 1
    `,[member_id]);

    const ev = !!ver.rows.find(r => r.ev);
    const pv = !!ver.rows.find(r => r.pv);
    if (!ev && !pv){
      return res.status(412).json({ ok:false, error:'unverified_contact', message:'Verify email or phone before creating a member profile.' });
    }

    // … your existing safe upsert for ff_member here …
    return res.json({ ok:true });
  }catch(e){
    console.error('[members.upsert] error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
