// src/api/members.js
const express = require('express');

function normalizePhone(s=''){
  return String(s).replace(/[^0-9]/g,''); // digits-only compare
}

module.exports = function createMembersRouter(pool){
  const router = express.Router();

  // accepts either querystring (GET) or JSON body (POST)
  async function lookup(req, res){
    try{
      const q = req.method === 'GET' ? req.query : (req.body || {});
      const member_id = (q.member_id || q.id || '').trim();
      const handle    = (q.handle || '').trim();
      const email     = (q.email || q.primary_email || '').trim().toLowerCase();
      const phoneNorm = normalizePhone(q.phone || q.primary_phone || '');

      const where = [];
      const params = [];
      let p = 1;

      if (member_id){
        where.push(`member_id = $${p++}`);
        params.push(member_id);
      }
      if (handle){
        where.push(`LOWER(handle) = LOWER($${p++})`);
        params.push(handle);
      }
      if (email){
        where.push(`LOWER(primary_email) = LOWER($${p++})`);
        params.push(email);
      }
      if (phoneNorm){
        // compare digits-only
        where.push(`regexp_replace(COALESCE(primary_phone,''), '[^0-9]', '', 'g') = $${p++}`);
        params.push(phoneNorm);
      }

      if (!where.length){
        return res.status(400).json({ ok:false, error:'missing_lookup_key' });
      }

      const { rows } = await pool.query(
        `SELECT member_id, handle, primary_email, primary_phone, created_at, updated_at
           FROM ff_member
          WHERE ${where.join(' OR ')}
          ORDER BY updated_at DESC
          LIMIT 1`
      , params);

      if (!rows[0]) return res.json({ ok:true, found:false, hit:null });

      return res.json({ ok:true, found:true, hit:rows[0] });
    } catch (e){
      console.error('[members.lookup]', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  router.get('/lookup', lookup);
  router.post('/lookup', express.json({ limit:'256kb' }), lookup);

  return router;
};
