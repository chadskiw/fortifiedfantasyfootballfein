// routes/identity.js  (CommonJS)
const express = require('express');
const crypto = require('crypto');

// must match your client-side rule
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

function norm(x = '') { return String(x).trim(); }
function isHandle(x) { return HANDLE_RE.test(norm(x)); }

module.exports = function createHandleUpsertRouter(pool) {
  const router = express.Router();

  // POST /
  // body: { handle }
  // cookie in/out: ff_member (set if we create a new member)
  router.post('/', async (req, res) => {
    try {
      const handleRaw = norm(req.body?.handle || req.body?.username || '');
      if (!isHandle(handleRaw)) {
        return res.status(400).json({ ok:false, error:'bad_handle' });
      }
      const handle = handleRaw;

      // if caller already has a member cookie, attempt to set username on that row
      const memberCookie = req.cookies?.ff_member ? String(req.cookies.ff_member).trim() : '';

      // check if handle already taken (ignoring deleted_at)
      const taken = await pool.query(
        `SELECT member_id FROM ff_member WHERE deleted_at IS NULL AND LOWER(username)=LOWER($1) LIMIT 1`,
        [handle]
      );
      if (taken.rows[0]) {
        // if it's this same member, treat as OK; else 409
        if (memberCookie && String(taken.rows[0].member_id) === memberCookie) {
          return res.json({ ok:true, member_id: memberCookie, username: handle });
        }
        return res.status(409).json({ ok:false, error:'handle_taken' });
      }

      if (memberCookie) {
        // update existing member
        const up = await pool.query(
          `UPDATE ff_member
             SET username=$1, updated_at=now()
           WHERE member_id=$2 AND deleted_at IS NULL
           RETURNING member_id`,
          [handle, memberCookie]
        );
        if (up.rows[0]) {
          return res.json({ ok:true, member_id: up.rows[0].member_id, username: handle });
        }
        // fallthrough: cookie invalid; create new
      }

      // create a new member row and set cookie
      const r = await pool.query(
        `INSERT INTO ff_member (username, first_seen_at, last_seen_at, event_count)
         VALUES ($1, now(), now(), 0)
         ON CONFLICT (username) DO NOTHING
         RETURNING member_id`,
        [handle]
      );

      if (!r.rows[0]) {
        // race: someone grabbed it between checks
        return res.status(409).json({ ok:false, error:'handle_taken' });
      }

      const memberId = String(r.rows[0].member_id);
      res.cookie('ff_member', memberId, {
        httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 365*24*60*60*1000
      });

      return res.json({ ok:true, member_id: memberId, username: handle });
    } catch (e) {
      console.error('[identity/handle/upsert]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  return router;
};
