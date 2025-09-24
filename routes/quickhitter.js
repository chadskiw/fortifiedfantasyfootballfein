// routes/quickhitter.js
const express = require('express');

// You exported pool & query from server.js; import accordingly:
const pool = require('../src/db/pool'); // direct, no circular dep
const router = express.Router();
router.use(express.json());

// ---------------- helpers ----------------
const HEX_RE = /^[#]?[0-9a-fA-F]{6}$/;
const HANDLE_OK = /^[A-Za-z0-9_.]+(?: [A-Za-z0-9_.]+)?$/; // internal single space allowed

const norm = v => String(v || '').trim();
const normHex = (v) => {
  const s = norm(v);
  if (!s || !HEX_RE.test(s)) return null;
  return s.startsWith('#') ? s.toUpperCase() : ('#' + s.toUpperCase());
};
const normHandle = (v) => {
  let s = norm(v);
  const m = s.match(/^\{\%?([A-Za-z0-9_. ]+?)\%?\}$/);
  if (m) s = m[1];
  s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  return s;
};
const isHandleShape = (s) => {
  const v = normHandle(s);
  return v.length >= 3 && v.length <= 24 && HANDLE_OK.test(v);
};
const e164 = (v) => {
  let t = (v || '').replace(/[^\d+]/g, '');
  if (t && !t.startsWith('+') && t.length === 10) t = '+1' + t;
  return t || null;
};
const isEmail = (v)=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(v));

// convenience
function rowToMember(row){
  if (!row) return null;
  const hex = row.color_hex ? (row.color_hex.startsWith('#') ? row.color_hex : ('#' + row.color_hex)) : null;
  return {
    member_id: row.member_id,
    handle   : row.handle,
    color_hex: hex,
    image_key: row.image_key,
    image_url: row.image_key ? `https://img.fortifiedfantasy.com/${row.image_key}` : null,
    email    : row.email,
    phone    : row.phone,
    email_is_verified: row.email_is_verified,
    phone_is_verified: row.phone_is_verified,
    quick_snap: row.quick_snap
  };
}
function isComplete(m){
  return !!(m
    && m.member_id && m.handle
    && (m.image_key || m.image_url)
    && m.color_hex
    && (m.email || m.phone));
}

// ---------------- routes ----------------

// GET /api/quickhitter/check
router.get('/check', async (req, res) => {
  try {
    const memberId = norm(req.cookies?.ff_member || '');
    if (!memberId) return res.json({ ok:true, complete:false });

    const { rows } = await pool.query(
      `SELECT * FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
      [memberId]
    );
    const m = rowToMember(rows[0]);
    return res.json({ ok:true, member:m, complete:isComplete(m) });
  } catch (e) {
    console.error('[qh.check]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/quickhitter/exists?handle=|email=|phone=
router.get('/exists', async (req, res) => {
  try {
    const handle = req.query.handle ? normHandle(req.query.handle) : null;
    const email  = req.query.email  ? norm(req.query.email)       : null;
    const phone  = req.query.phone  ? e164(req.query.phone)       : null;

    if (handle) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1)`,
        [handle]
      );
      return res.json({ ok:true, exists: r.rows[0].c > 0 });
    }
    if (email) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c, BOOL_OR(email_is_verified) AS v
           FROM ff_quickhitter WHERE LOWER(email)=LOWER($1)`,
        [email.toLowerCase()]
      );
      return res.json({ ok:true, exists: r.rows[0].c > 0, verified: !!r.rows[0].v });
    }
    if (phone) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c, BOOL_OR(phone_is_verified) AS v
           FROM ff_quickhitter WHERE phone=$1`,
        [phone]
      );
      return res.json({ ok:true, exists: r.rows[0].c > 0, verified: !!r.rows[0].v });
    }
    return res.status(400).json({ ok:false, error:'bad_request' });
  } catch (e) {
    console.error('[qh.exists]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/quickhitter/colors?handle=Foo
router.get('/colors', async (req, res) => {
  try {
    const handle = req.query.handle ? normHandle(req.query.handle) : null;
    if (!handle || !isHandleShape(handle)) {
      return res.status(400).json({ ok:false, error:'bad_handle' });
    }
    const r = await pool.query(
      `SELECT DISTINCT color_hex FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1) AND color_hex IS NOT NULL`,
      [handle]
    );
    const used = r.rows.map(x => '#' + String(x.color_hex || '').replace(/^#/,'').toUpperCase());
    const palette = ['#77E0FF','#61D095','#FFD166','#FF6B6B','#A78BFA','#F472B6','#34D399','#F59E0B','#22D3EE','#E879F9'];
    res.json({ ok:true, used, palette });
  } catch (e) {
    console.error('[qh.colors]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/quickhitter/handle/:handle  → list variants (for chooser)
router.get('/handle/:handle', async (req, res) => {
  try {
    const handle = normHandle(req.params.handle);
    if (!isHandleShape(handle)) return res.status(400).json({ ok:false, error:'bad_handle' });
    const { rows } = await pool.query(
      `SELECT member_id, handle, color_hex, image_key
         FROM ff_quickhitter
        WHERE LOWER(handle)=LOWER($1)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 32`,
      [handle]
    );
    const items = rows.map(r => ({
      member_id: r.member_id,
      handle: r.handle,
      color_hex: r.color_hex ? (r.color_hex.startsWith('#') ? r.color_hex : ('#'+r.color_hex)) : null,
      image_key: r.image_key
      // adj1/adj2/noun not stored here; leave nulls (your descriptor API can supply later)
    }));
    res.json({ ok:true, items });
  } catch (e) {
    console.error('[qh.handle]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/quickhitter/upsert
// body: { member_id?, handle?, color_hex?, image_key?, email?, phone? }
router.post('/upsert', async (req, res) => {
  try {
    const body = req.body || {};
    let member_id = norm(body.member_id || req.cookies?.ff_member || '');
    if (!member_id) {
      // generate 8-char A-Z0-9
      member_id = [...crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi,'')]
        .filter(ch => /[A-Z0-9]/i.test(ch)).slice(0,8).join('').toUpperCase();
    }

    const handle = body.handle ? normHandle(body.handle) : null;
    const color  = body.color_hex ? normHex(body.color_hex) : null;
    const image  = norm(body.image_key || '');
    const email  = body.email && isEmail(body.email) ? body.email.toLowerCase() : null;
    const phone  = body.phone ? e164(body.phone) : null;

    // soft validations
    if (handle && !isHandleShape(handle)) return res.status(400).json({ ok:false, error:'bad_handle' });

    const fields = {
      member_id,
      handle,
      color_hex: color ? color.replace(/^#/,'') : null,
      image_key: image || null,
      email,
      phone,
      email_is_verified: !!body.email_is_verified,
      phone_is_verified: !!body.phone_is_verified
    };

    // upsert by member_id
    const sql = `
      INSERT INTO ff_quickhitter (
        member_id, handle, color_hex, image_key, email, phone, email_is_verified, phone_is_verified
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (member_id) DO UPDATE SET
        handle = COALESCE(EXCLUDED.handle, ff_quickhitter.handle),
        color_hex = COALESCE(EXCLUDED.color_hex, ff_quickhitter.color_hex),
        image_key = COALESCE(EXCLUDED.image_key, ff_quickhitter.image_key),
        email = COALESCE(EXCLUDED.email, ff_quickhitter.email),
        phone = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
        email_is_verified = ff_quickhitter.email_is_verified OR EXCLUDED.email_is_verified,
        phone_is_verified = ff_quickhitter.phone_is_verified OR EXCLUDED.phone_is_verified,
        updated_at = NOW()
      RETURNING *;
    `;
    const params = [
      fields.member_id, fields.handle, fields.color_hex, fields.image_key,
      fields.email, fields.phone, fields.email_is_verified, fields.phone_is_verified
    ];
    const { rows } = await pool.query(sql, params);
    const m = rowToMember(rows[0]);

    // refresh cookie so client flows can “see” member
    res.cookie('ff_member', m.member_id, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });

    res.json({ ok:true, member_id: m.member_id, handle: m.handle, color_hex: m.color_hex, image_key: m.image_key });
  } catch (e) {
    console.error('[qh.upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
