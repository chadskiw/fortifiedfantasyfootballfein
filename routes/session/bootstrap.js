// routes/session-bootstrap.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../../src/db/pool');

const router = express.Router();
const norm = s => String(s||'').trim().toUpperCase();
const normSwid = s => {
  const v = norm(decodeURIComponent(s||''));
  if (!v) return '';
  const bare = v.replace(/[{}]/g,'');
  return `{${bare}}`;
};

router.get('/', async (req,res) => {
  try {
    // already has an ff_sid? you're done
    const sid = req.cookies?.ff_sid;
    if (sid) {
      const q = await pool.query('select member_id from ff_session where session_id=$1 limit 1',[sid]);
      if (q.rowCount) return res.json({ ok:true, member_id:q.rows[0].member_id, source:'sid' });
    }

    const memberId = req.cookies?.ff_member || '';
    const swidCookie = normSwid(req.cookies?.SWID || req.cookies?.ff_espn_swid || '');

    if (!memberId || !swidCookie) return res.status(401).json({ ok:false, error:'missing_pair' });

    // fetch the user’s primary swid from quickhitter
    const r = await pool.query(
      `select member_id, handle, color_hex, quick_snap, email, phone
         from ff_quickhitter where member_id=$1 limit 1`,
      [memberId]
    );
    const row = r.rows[0];
    if (!row) return res.status(401).json({ ok:false, error:'no_quickhitter' });

    const dbSwid = normSwid(row.quick_snap);
    if (dbSwid !== swidCookie) return res.status(401).json({ ok:false, error:'swid_mismatch' });

    // looks good → mint a real session
    const newSid = crypto.randomUUID().replace(/-/g,'');
    await pool.query(
      `insert into ff_session (session_id, member_id, created_at, last_seen_at, ip_hash, user_agent)
       values ($1,$2, now(), now(),
               encode(digest($3,'sha256'),'hex'),
               left($4,300))`,
      [newSid, memberId, req.ip||'', req.headers['user-agent']||'']
    );

    res.cookie('ff_sid', newSid, { httpOnly:true, sameSite:'Lax', secure:true, path:'/', maxAge:30*24*3600*1000 });
    res.cookie('ff_logged_in', '1', { sameSite:'Lax', secure:true, path:'/', maxAge:30*24*3600*1000 });

    res.json({
      ok:true,
      member: {
        member_id: row.member_id,
        handle: row.handle,
        color_hex: row.color_hex,
        email: row.email,
        phone: row.phone
      },
      source:'ff_member+swid'
    });
  } catch (e) {
    console.error('[bootstrap]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
