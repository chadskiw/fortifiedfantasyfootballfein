const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');           // adjust if needed
const { setSessionCookie } = require('../../lib/cookies'); // or inline res.cookie

const router = express.Router();

/**
 * Body: { member_id?, handle?, hex?, email?, phone? }
 * Rule to accept as login:
 *   - row exists in ff_quickhitter
 *   - row has handle + color_hex
 *   - row has at least one contact (email OR phone)
 *   - if client sent handle, it matches (ci)
 *   - if client sent email/phone, at least one matches
 */
router.post('/login-from-pre', async (req, res) => {
  try {
    const b = req.body || {};
    const wantHandle = (b.handle || '').trim();
    const wantHex    = (b.hex || '').replace('#','').trim().toUpperCase();
    const wantEmail  = (b.email || '').trim().toLowerCase();
    const wantPhone  = (b.phone || '').replace(/[^\d+]/g,''); // E.164-lite

    // Load the candidate quickhitter row
    let row;
    if (b.member_id) {
      const r = await pool.query(
        `SELECT * FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`, [b.member_id]
      );
      row = r.rows[0];
    } else if (wantHandle) {
      const r = await pool.query(
        `SELECT * FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
        [wantHandle]
      );
      row = r.rows[0];
    }

    if (!row) return res.status(404).json({ ok:false, error:'no_quickhitter' });

    const haveHandle = !!row.handle;
    const haveHex    = !!row.color_hex;
    const haveContact = !!(row.email || row.phone);

    // handle/hex/contact must exist on the row
    if (!(haveHandle && haveHex && haveContact)) {
      return res.json({ ok:true, logged_in:false, reason:'incomplete_row' });
    }

    // If client provided a handle, it must match
    if (wantHandle && wantHandle.toLowerCase() !== row.handle.toLowerCase()) {
      return res.json({ ok:true, logged_in:false, reason:'handle_mismatch' });
    }

    // If client provided a hex, prefer to confirm it too (optional but strengthens the check)
    if (wantHex && wantHex !== String(row.color_hex || '').toUpperCase().replace('#','')) {
      return res.json({ ok:true, logged_in:false, reason:'hex_mismatch' });
    }

    // If client provided a contact, one must match
    const matchesEmail = wantEmail && row.email && wantEmail === row.email.toLowerCase();
    const matchesPhone = wantPhone && row.phone && wantPhone === row.phone.replace(/[^\d+]/g,'');
    if ((wantEmail || wantPhone) && !(matchesEmail || matchesPhone)) {
      return res.json({ ok:true, logged_in:false, reason:'contact_mismatch' });
    }

    // All good: create a session
    const memberId = row.member_id;
    const sid = crypto.randomUUID().replace(/-/g,'');
    await pool.query(
      `INSERT INTO ff_session (session_id, member_id, created_at, last_seen_at, ip_hash, user_agent)
       VALUES ($1,$2, now(), now(),
         encode(digest($3,'sha256'),'hex'),
         $4)`,
      [ sid, memberId, String(req.ip||''), String(req.headers['user-agent']||'').slice(0,300) ]
    );

    // Set the whoami cookie
    if (typeof setSessionCookie === 'function') {
      setSessionCookie(res, sid); // your helper sets httpOnly/Lax/etc.
    } else {
      res.cookie('ff_sid', sid, {
        httpOnly: true, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production', path: '/',
        maxAge: 30*24*60*60*1000
      });
    }

    // Nice-to-have: refresh the simple marker too
    res.cookie('ff_member', memberId, {
      httpOnly: true, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production', path: '/',
      maxAge: 365*24*60*60*1000
    });

    return res.json({ ok:true, logged_in:true, member_id: memberId });
  } catch (e) {
    console.error('[session.login-from-pre]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
