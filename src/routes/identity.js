// src/routes/identity.js
// temporary stub: routes/identity/request-code.js or inline
const express = require('express');
const stub = express.Router();
stub.post('/', (req,res)=> res.json({ ok:true, step:'stubbed' }));
module.exports = stub;
// mount: app.use('/api/identity/request-code', require('./routes/identity/request-code'));


// const express = require('express');
const pool    = require('../db/pool');
const router  = express.Router();

const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const norm = v => String(v||'').trim();

function currentMemberId(req){
  // adjust to your cookie/session. For now, use cookie "ff_member".
  const m = norm(req.cookies?.ff_member);
  return m || null;
}

// GET /api/identity/handle/exists?u=foo
router.get('/handle/exists', async (req, res) => {
  const u = norm(req.query.u || req.query.username);
  if (!HANDLE_RE.test(u)) return res.json({ ok:true, handle:u, available:false, reason:'invalid_shape' });

  const r = await pool.query(
    `SELECT 1 FROM ff_member WHERE deleted_at IS NULL AND LOWER(username)=LOWER($1) LIMIT 1`,
    [u]
  );
  res.json({ ok:true, handle:u, available: r.rowCount === 0, taken: r.rowCount > 0 });
});

// POST /api/identity/handle/upsert { handle }
router.post('/handle/upsert', async (req, res) => {
  const me = currentMemberId(req);
  if (!me) return res.status(401).json({ ok:false, error:'unauthorized' });

  const h = norm(req.body?.handle || req.body?.username);
  if (!HANDLE_RE.test(h)) return res.status(422).json({ ok:false, error:'invalid_handle' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const m = await client.query(`SELECT member_id FROM ff_member WHERE member_id=$1 AND deleted_at IS NULL FOR UPDATE`, [me]);
    if (!m.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'member_not_found' }); }

    const upd = await client.query(
      `UPDATE ff_member SET username=$1, updated_at=NOW() WHERE member_id=$2 RETURNING member_id, username`,
      [h, me]
    );

    await client.query('COMMIT');
    return res.json({ ok:true, member_id: upd.rows[0].member_id, handle: upd.rows[0].username });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.code) === '23505') return res.status(409).json({ ok:false, error:'handle_taken' });
    console.error('[handle/upsert]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  } finally {
    client.release();
  }
});

module.exports = router;

