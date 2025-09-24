// routes/identity/handle.js (CommonJS)
const express = require('express');
const pool    = require('../pool'); // adjust path if needed (must export a pg.Pool)
const router  = express.Router();

const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

function toHandle(x){ return String(x || '').trim(); }
function bad(res, code, error, message){ return res.status(code).json({ ok:false, error, message }); }

// Replace with your actual member resolver
async function getCurrentMemberId(req){
  const m = String(req.cookies?.ff_member || '').trim();
  return m || null;
}

// GET /api/identity/handle/exists?u=foo
router.get('/handle/exists', async (req, res) => {
  try{
    const raw = toHandle(req.query.u);
    if (!HANDLE_RE.test(raw)) {
      return res.json({ ok:true, handle:raw, available:false, reason:'invalid_shape' });
    }

    const { rows } = await pool.query(
      `SELECT 1
         FROM ff_member
        WHERE deleted_at IS NULL
          AND LOWER(username) = LOWER($1)
        LIMIT 1`,
      [raw]
    );

    const taken = rows.length > 0;
    res.json({ ok:true, handle:raw, available:!taken, taken });
  }catch(e){
    console.error('[handle/exists]', e);
    res.status(500).json({ ok:false, error:'internal', message:'exists failed' });
  }
});

// POST /api/identity/handle/upsert { handle }
router.post('/handle/upsert', express.json(), async (req, res) => {
  try{
    const me  = await getCurrentMemberId(req);
    if (!me) return bad(res, 401, 'unauthorized', 'No member session');

    const raw = toHandle(req.body?.handle);
    if (!HANDLE_RE.test(raw)) return bad(res, 422, 'invalid_handle', 'Handle must be 3–24 chars (letters, numbers, "_" or ".")');

    const client = await pool.connect();
    try{
      await client.query('BEGIN');

      const m = await client.query(
        `SELECT member_id, username
           FROM ff_member
          WHERE member_id = $1
            AND deleted_at IS NULL
          FOR UPDATE`,
        [me]
      );
      if (!m.rowCount){
        await client.query('ROLLBACK');
        return bad(res, 404, 'member_not_found', 'Member not found');
      }

      const u = await client.query(
        `UPDATE ff_member
            SET username = $1,
                updated_at = NOW()
          WHERE member_id = $2
          RETURNING member_id, username`,
        [raw, me]
      );

      await client.query('COMMIT');
      return res.json({ ok:true, member_id: u.rows[0].member_id, handle: u.rows[0].username });
    }catch(err){
      await client.query('ROLLBACK');
      if (String(err.code) === '23505') { // unique_violation
        return bad(res, 409, 'handle_taken', 'That handle is already taken');
      }
      console.error('[handle/upsert] tx', err);
      return bad(res, 500, 'internal', 'Could not save handle');
    }finally{
      client.release();
    }
  }catch(e){
    console.error('[handle/upsert]', e);
    res.status(500).json({ ok:false, error:'internal', message:'upsert failed' });
  }
});

module.exports = router;
