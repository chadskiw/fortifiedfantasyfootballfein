// routes/quickhitter.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
router.use(express.json());

// ---------- DB pool ----------
let db = require('../src/db/pool'); // adjust if needed
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

// ---------- CDN helpers ----------
const { toCdnUrl, stripCdn } = require('../lib/cdn');

// ---------- validators / utils ----------
const HEX_RE      = /^[#]?[0-9a-fA-F]{6}$/;
const HANDLE_OK   = /^[A-Za-z0-9_.]+(?: [A-Za-z0-9_.]+)?$/; // allow one internal space
const EMAIL_RE    = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE     = /^\+[1-9]\d{7,14}$/; // ITU E.164

const PALETTE = [
  '#77E0FF','#61D095','#FFD166','#FF6B6B','#A78BFA',
  '#F472B6','#34D399','#F59E0B','#22D3EE','#E879F9'
];

const norm       = v => String(v || '').trim();
const normHex    = v => {
  const s = norm(v);
  if (!s || !HEX_RE.test(s)) return null;
  const up = s.replace('#','').toUpperCase();
  return '#' + up;
};
const normHandle = v => {
  let s = norm(v);
  const m = s.match(/^\{\%?([A-Za-z0-9_. ]+?)\%?\}$/); // tolerate {%foo%}
  if (m) s = m[1];
  return s.replace(/\s+/g, ' ').trim();
};
const isHandleShape = s => {
  const v = normHandle(s);
  return v.length >= 3 && v.length <= 24 && HANDLE_OK.test(v);
};
const toE164 = v => {
  const digits = String(v || '').replace(/\D+/g,'');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
};
const isEmail  = v => EMAIL_RE.test(norm(v));
const isE164   = v => E164_RE.test(String(v||'').trim());

function rowToMember(row) {
  if (!row) return null;
  const hex = row.color_hex
    ? (String(row.color_hex).startsWith('#') ? row.color_hex : ('#' + row.color_hex))
    : null;
  const image_key = row.image_key || null;
  const image_url = image_key ? toCdnUrl(image_key) : null;
  return {
    member_id         : row.member_id,
    handle            : row.handle,
    color_hex         : hex,
    image_key,
    image_url,
    email             : row.email || null,
    phone             : row.phone || null,
    email_is_verified : !!row.email_is_verified,
    phone_is_verified : !!row.phone_is_verified,
    quick_snap        : row.quick_snap || null
  };
}

function isComplete(m) {
  // consider "complete" once we have member_id + handle + color + any contact
  return !!(m && m.member_id && m.handle && m.color_hex && (m.email || m.phone));
}

// ----- session + contact owner helpers -----
function getSessionMemberId(req) {
  // your session cookie is 'ff_member'
  return (req?.cookies?.ff_member && String(req.cookies.ff_member).trim()) || null;
}

// Return { member_id, source } or null, checking both tables
async function ownerOfEmail(email) {
  if (!email) return null;
  const { rows } = await pool.query(
    `
    SELECT member_id,'member' AS source FROM ff_member WHERE LOWER(email)=LOWER($1) AND member_id IS NOT NULL
    UNION ALL
    SELECT member_id,'quickhitter' AS source FROM ff_quickhitter WHERE LOWER(email)=LOWER($1) AND member_id IS NOT NULL
    LIMIT 1
    `,
    [email.toLowerCase()]
  );
  return rows[0] || null;
}
async function ownerOfPhone(phone) {
  if (!phone) return null;
  const { rows } = await pool.query(
    `
    SELECT member_id,'member' AS source FROM ff_member WHERE phone_e164=$1 AND member_id IS NOT NULL
    UNION ALL
    SELECT member_id,'quickhitter' AS source FROM ff_quickhitter WHERE phone=$1 AND member_id IS NOT NULL
    LIMIT 1
    `,
    [phone]
  );
  return rows[0] || null;
}

// ---------- helpers: used colors across both tables ----------
async function usedColorsForHandle(handle) {
  const h = normHandle(handle);
  if (!h) return new Set();

  const { rows } = await pool.query(
    `
    WITH u AS (
      SELECT color_hex FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1) AND color_hex IS NOT NULL
      UNION
      SELECT color_hex FROM ff_member      WHERE LOWER(handle)=LOWER($1) AND color_hex IS NOT NULL
    )
    SELECT DISTINCT color_hex FROM u
    `,
    [h]
  );
  const set = new Set();
  for (const r of rows) {
    const up = String(r.color_hex || '').replace('#','').toUpperCase();
    if (up) set.add('#' + up);
  }
  return set;
}
async function pickColorForHandleAvoidingCollisions(handle, desiredHex) {
  const used = await usedColorsForHandle(handle);
  if (desiredHex) {
    const want = normHex(desiredHex);
    if (want && !used.has(want)) return want;
  }
  for (const hex of PALETTE) {
    if (!used.has(hex)) return hex;
  }
  return null;
}

// ===================================================================
// GET /api/quickhitter/check  → { ok, complete, member }
// ===================================================================
router.get('/check', async (req, res) => {
  try {
    const memberId = norm(req.cookies?.ff_member || '');
    if (!memberId) return res.json({ ok: true, complete: false });
    const { rows } = await pool.query(`SELECT * FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`, [memberId]);
    const m = rowToMember(rows[0]);
    return res.json({ ok: true, member: m, complete: isComplete(m) });
  } catch (e) {
    console.error('[qh.check]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// GET /api/quickhitter/exists?handle=|email=|phone= → { ok, exists, verified? }
// (checks across both tables)
// ===================================================================
router.get('/exists', async (req, res) => {
  try {
    const handle = req.query.handle ? normHandle(req.query.handle) : null;
    const email  = req.query.email  ? norm(req.query.email).toLowerCase() : null;
    const phone  = req.query.phone  ? toE164(req.query.phone) : null;

    if (handle) {
      const { rows } = await pool.query(
        `
        SELECT (COUNT(*) > 0) AS exists
        FROM (
          SELECT 1 FROM ff_quickhitter WHERE LOWER(handle)=LOWER($1)
          UNION ALL
          SELECT 1 FROM ff_member      WHERE LOWER(handle)=LOWER($1)
        ) t
        `,
        [handle]
      );
      return res.json({ ok: true, exists: !!rows[0]?.exists });
    }
    if (email) {
      const { rows } = await pool.query(
        `
        SELECT COUNT(*)::int AS c, BOOL_OR(email_is_verified) AS v
        FROM (
          SELECT email_is_verified FROM ff_quickhitter WHERE LOWER(email)=LOWER($1)
          UNION ALL
          SELECT (email_verified_at IS NOT NULL) AS email_is_verified FROM ff_member WHERE LOWER(email)=LOWER($1)
        ) t
        `,
        [email]
      );
      return res.json({ ok: true, exists: rows[0].c > 0, verified: !!rows[0].v });
    }
    if (phone) {
      const { rows } = await pool.query(
        `
        SELECT COUNT(*)::int AS c, BOOL_OR(phone_is_verified) AS v
        FROM (
          SELECT phone_is_verified FROM ff_quickhitter WHERE phone=$1
          UNION ALL
          SELECT (phone_verified_at IS NOT NULL) AS phone_is_verified FROM ff_member WHERE phone_e164=$1
        ) t
        `,
        [phone]
      );
      return res.json({ ok: true, exists: rows[0].c > 0, verified: !!rows[0].v });
    }
    return res.status(400).json({ ok: false, error: 'bad_request' });
  } catch (e) {
    console.error('[qh.exists]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// GET /api/quickhitter/colors?handle=Foo → { ok, used:[#...], palette:[#...] }
// ===================================================================
router.get('/colors', async (req, res) => {
  try {
    const handle = req.query.handle ? normHandle(req.query.handle) : null;
    if (!handle || !isHandleShape(handle)) {
      return res.status(400).json({ ok: false, error: 'bad_handle' });
    }
    const usedSet = await usedColorsForHandle(handle);
    res.json({ ok: true, used: Array.from(usedSet), palette: PALETTE });
  } catch (e) {
    console.error('[qh.colors]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// GET /api/quickhitter/handle/:handle → { ok, items:[...] } (chooser list)
// ===================================================================
router.get('/handle/:handle', async (req, res) => {
  try {
    const handle = normHandle(req.params.handle);
    if (!isHandleShape(handle)) return res.status(400).json({ ok: false, error: 'bad_handle' });

    const { rows } = await pool.query(
      `SELECT member_id, handle, color_hex, image_key, created_at, updated_at
         FROM ff_quickhitter
        WHERE LOWER(handle)=LOWER($1)
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 32`,
      [handle]
    );

    const items = rows.map(r => ({
      member_id : r.member_id,
      handle    : r.handle,
      color_hex : r.color_hex ? (String(r.color_hex).startsWith('#') ? r.color_hex : ('#'+r.color_hex)) : null,
      image_key : r.image_key,
      image_url : r.image_key ? toCdnUrl(r.image_key) : null
    }));

    res.json({ ok: true, items });
  } catch (e) {
    console.error('[qh.handle]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// GET /api/quickhitter/lookup?handle=|email=|phone= → { ok, candidates:[...] }
// ===================================================================
router.get('/lookup', async (req, res) => {
  try{
    const { handle, email, phone } = req.query;
    if (handle) {
      const { rows } = await pool.query(`
        SELECT q.member_id, q.handle, q.color_hex, q.image_key,
               q.email, q.phone,
               (fm.member_id IS NOT NULL) AS is_member
          FROM ff_quickhitter q
          LEFT JOIN ff_member fm ON fm.member_id = q.member_id
         WHERE LOWER(q.handle)=LOWER($1)
         ORDER BY q.updated_at DESC
         LIMIT 32
      `,[String(handle)]);
      return res.json({ ok:true, candidates: rows });
    }
    if (email) {
      const { rows } = await pool.query(`
        SELECT q.member_id, q.handle, q.color_hex, q.image_key, q.email, q.phone,
               (fm.member_id IS NOT NULL) AS is_member
          FROM ff_quickhitter q
          LEFT JOIN ff_member fm ON fm.member_id = q.member_id
         WHERE LOWER(q.email)=LOWER($1)
         LIMIT 1
      `,[String(email).toLowerCase()]);
      return res.json({ ok:true, candidates: rows });
    }
    if (phone) {
      const e = toE164(phone);
      const { rows } = await pool.query(`
        SELECT q.member_id, q.handle, q.color_hex, q.image_key, q.email, q.phone,
               (fm.member_id IS NOT NULL) AS is_member
          FROM ff_quickhitter q
          LEFT JOIN ff_member fm ON fm.member_id = q.member_id
         WHERE q.phone=$1
         LIMIT 1
      `,[String(e)]);
      return res.json({ ok:true, candidates: rows });
    }
    res.status(400).json({ ok:false, error:'bad_request' });
  }catch(e){
    console.error('[qh.lookup]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ===================================================================
// POST /api/quickhitter/upsert
// body: { member_id?, handle?, color_hex?, image_key? | image_url?, email?, phone?, email_is_verified?, phone_is_verified? }
// - Conflicts on (member_id) only.
// - Preflight rejects if email/phone belong to another member across BOTH tables (409).
// - Validates formats and returns 422 for bad email/phone.
// ===================================================================
router.post('/upsert', async (req, res) => {
  try{
    const body = req.body || {};

    // resolve member_id: session → body → cookie → generate
    let member_id = getSessionMemberId(req)
                 || (body && String(body.member_id || '').trim())
                 || (req.cookies && String(req.cookies.ff_member || '').trim());

    if (!member_id) {
      member_id = crypto.randomBytes(8).toString('base64')
        .replace(/[^A-Z0-9]/gi,'').slice(0,8).toUpperCase();
    }

    const handleIn = body.handle ? normHandle(body.handle) : null;
    if (handleIn && !isHandleShape(handleIn)) {
      return res.status(400).json({ ok:false, error:'bad_handle' });
    }

    const colorIn  = body.color_hex ? normHex(body.color_hex) : null;
    const image_key = stripCdn(body.image_key || body.image_url || '') || null;

    // normalize + validate contacts
    const email = body.email ? String(body.email).trim().toLowerCase() : null;
    const phone = body.phone ? toE164(body.phone) : null;

    if (email && !isEmail(email)) {
      return res.status(422).json({ ok:false, error:'invalid_email', message:'Email looks invalid.' });
    }
    if (phone && !isE164(phone)) {
      return res.status(422).json({ ok:false, error:'invalid_phone', message:'Phone must be E.164 like +15551231234.' });
    }

    // ownership conflict across BOTH tables
    if (email) {
      const own = await ownerOfEmail(email);
      if (own && own.member_id !== member_id) {
        // include a small owner block (image_url falls back to /logo.png)
        const { rows } = await pool.query(
          `SELECT member_id, handle, color_hex, image_key FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
          [own.member_id]
        );
        const owner = rows[0] || null;
        return res.status(409).json({
          ok:false, error:'contact_belongs_to_other', conflict:'email',
          owner: owner ? {
            member_id: owner.member_id,
            handle: owner.handle,
            color_hex: owner.color_hex,
            image_key: owner.image_key,
            image_url: owner.image_key ? toCdnUrl(owner.image_key) : '/logo.png'
          } : null
        });
      }
    }
    if (phone) {
      const own = await ownerOfPhone(phone);
      if (own && own.member_id !== member_id) {
        const { rows } = await pool.query(
          `SELECT member_id, handle, color_hex, image_key FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
          [own.member_id]
        );
        const owner = rows[0] || null;
        return res.status(409).json({
          ok:false, error:'contact_belongs_to_other', conflict:'phone',
          owner: owner ? {
            member_id: owner.member_id,
            handle: owner.handle,
            color_hex: owner.color_hex,
            image_key: owner.image_key,
            image_url: owner.image_key ? toCdnUrl(owner.image_key) : '/logo.png'
          } : null
        });
      }
    }

    // avoid color collision (prefer requested if free)
    let color = colorIn;
    if (handleIn && colorIn) {
      const wanted = colorIn.replace(/^#/, '').toUpperCase();
      const r = await pool.query(
        `SELECT 1 FROM ff_member WHERE LOWER(handle)=LOWER($1) AND UPPER(color_hex)=UPPER($2) LIMIT 1`,
        [handleIn, wanted]
      );
      if (r.rows[0]) {
        let picked = await pickColorForHandleAvoidingCollisions(handleIn, null);
        color = picked || colorIn;
      }
    }

    // upsert into ff_quickhitter
    const sql = `
      INSERT INTO ff_quickhitter (
        member_id, handle, color_hex, image_key, email, phone,
        email_is_verified, phone_is_verified
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (member_id) DO UPDATE SET
        handle             = COALESCE(EXCLUDED.handle, ff_quickhitter.handle),
        color_hex          = COALESCE(EXCLUDED.color_hex, ff_quickhitter.color_hex),
        image_key          = COALESCE(EXCLUDED.image_key, ff_quickhitter.image_key),
        email              = COALESCE(EXCLUDED.email, ff_quickhitter.email),
        phone              = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
        email_is_verified  = ff_quickhitter.email_is_verified  OR EXCLUDED.email_is_verified,
        phone_is_verified  = ff_quickhitter.phone_is_verified  OR EXCLUDED.phone_is_verified,
        updated_at         = NOW()
      RETURNING *;
    `;
    const params = [
      member_id,
      handleIn,
      color ? color.replace(/^#/,'') : null,
      image_key,
      email,
      phone,
      !!body.email_is_verified,
      !!body.phone_is_verified
    ];
    const { rows } = await pool.query(sql, params);
    const m = rowToMember(rows[0]);

    // refresh cookie
    res.cookie('ff_member', m.member_id, {
      httpOnly: true, secure: true, sameSite: 'Lax',
      maxAge: 365*24*3600*1000
    });

    return res.json({
      ok:true,
      member_id: m.member_id,
      handle: m.handle,
      color_hex: m.color_hex,
      image_key: m.image_key
    });
  } catch (e) {
    console.error('[qh.upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
