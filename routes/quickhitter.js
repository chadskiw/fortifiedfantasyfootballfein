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
const e164 = v => {
  let t = (v || '').replace(/[^\d+]/g, '');
  if (t && !t.startsWith('+') && t.length === 10) t = '+1' + t;
  return t || null;
};
const isEmail = v => EMAIL_RE.test(norm(v));

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
  // consider "complete" once we have member_id + handle + color + any contact + (avatar optional)
  return !!(m && m.member_id && m.handle && m.color_hex && (m.email || m.phone));
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
  // can we keep the desired?
  if (desiredHex) {
    const want = normHex(desiredHex);
    if (want && !used.has(want)) return want;
  }
  // else pick first free from palette
  for (const hex of PALETTE) {
    if (!used.has(hex)) return hex;
  }
  return null; // none left
}

// ---------- helpers: uniqueness checks for email/phone ----------
async function emailTakenByOtherMember(email, memberId) {
  if (!email) return false;
  const { rows } = await pool.query(
    `
    SELECT member_id FROM (
      SELECT member_id FROM ff_member      WHERE LOWER(email)=LOWER($1)
      UNION ALL
      SELECT member_id FROM ff_quickhitter WHERE LOWER(email)=LOWER($1)
    ) t
    WHERE member_id IS NOT NULL
    LIMIT 1
    `,
    [email]
  );
  const owner = rows[0]?.member_id || null;
  return owner && owner !== memberId;
}

async function phoneTakenByOtherMember(phone, memberId) {
  if (!phone) return false;
  const { rows } = await pool.query(
    `
    SELECT member_id FROM (
      SELECT member_id FROM ff_member      WHERE phone_e164=$1
      UNION ALL
      SELECT member_id FROM ff_quickhitter WHERE phone=$1
    ) t
    WHERE member_id IS NOT NULL
    LIMIT 1
    `,
    [phone]
  );
  const owner = rows[0]?.member_id || null;
  return owner && owner !== memberId;
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
    const phone  = req.query.phone  ? e164(req.query.phone) : null;

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
// (union of quickhitter + member to avoid collisions later)
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
      const { rows } = await pool.query(`
        SELECT q.member_id, q.handle, q.color_hex, q.image_key, q.email, q.phone,
               (fm.member_id IS NOT NULL) AS is_member
          FROM ff_quickhitter q
          LEFT JOIN ff_member fm ON fm.member_id = q.member_id
         WHERE q.phone=$1
         LIMIT 1
      `,[String(phone)]);
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
// - Repicks color on (handle,color) collision across BOTH tables.
// - Preflight rejects if email/phone belong to another member (409).
// ===================================================================
router.post('/upsert', async (req, res) => {
  try {
    const body = req.body || {};

    // resolve member_id: session → cookie → new
    let member_id = (await getSessionMemberId(req))
                 || norm(body.member_id || req.cookies?.ff_member || '');
    if (!member_id) {
      member_id = crypto.randomBytes(8).toString('base64').replace(/[^A-Z0-9]/gi,'').slice(0,8).toUpperCase();
    }

    const handle = body.handle ? normHandle(body.handle) : null;
    let color    = body.color_hex ? normHex(body.color_hex) : null;
    const email  = body.email && isEmail(body.email) ? body.email.toLowerCase() : null;
    const phone  = body.phone ? e164(body.phone) : null;
    const image_key = stripCdn(body.image_key || body.image_url || '');

    if (handle && !isHandleShape(handle)) {
      return res.status(400).json({ ok:false, error:'bad_handle' });
    }

    // If contact exists, only error if it belongs to someone ELSE.
    if (email || phone) {
      const owner = await ownerOfContact({ email, phone });
      if (owner && owner !== member_id) {
        // OPTIONAL: you could "attach" to owner here if you want, but
        // per your note, we keep the boundary and signal a clear conflict:
        return res.status(409).json({ ok:false, error:'contact_belongs_to_other', owner_member_id: owner });
      }
    }

    // (optional) repick color only against ff_member, not staging
    if (handle && color) {
      const wanted = color.replace(/^#/, '').toUpperCase();
      const r = await pool.query(
        `SELECT 1 FROM ff_member WHERE LOWER(handle)=LOWER($1) AND UPPER(color_hex)=UPPER($2) LIMIT 1`,
        [handle, wanted]
      );
      if (r.rows[0]) {
        const palette = ['#77E0FF','#61D095','#FFD166','#FF6B6B','#A78BFA','#F472B6','#34D399','#F59E0B','#22D3EE','#E879F9'];
        let picked = null;
        for (const hex of palette) {
          const r2 = await pool.query(
            `SELECT 1 FROM ff_member WHERE LOWER(handle)=LOWER($1) AND UPPER(color_hex)=UPPER($2) LIMIT 1`,
            [handle, hex.replace(/^#/, '').toUpperCase()]
          );
          if (!r2.rows[0]) { picked = hex; break; }
        }
        color = picked || color; // fallback to original if none free
      }
    }

    // proceed with your INSERT ... ON CONFLICT (member_id) DO UPDATE (unchanged)
    const sql = `
      INSERT INTO ff_quickhitter (
        member_id, handle, color_hex, image_key, email, phone,
        email_is_verified, phone_is_verified
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
      member_id,
      handle,
      color ? color.replace(/^#/,'') : null,
      image_key || null,
      email,
      phone,
      !!body.email_is_verified,
      !!body.phone_is_verified
    ];
    const { rows } = await pool.query(sql, params);
    const m = rowToMember(rows[0]);

    // refresh cookies/session as you already do...
    res.cookie('ff_member', m.member_id, { httpOnly:true, secure:true, sameSite:'Lax', maxAge: 365*24*3600*1000 });
    if (!req.cookies?.ff_sid) {
      // (optional) create session if missing, reusing your session util
      // await createSession(m.member_id, req, 30);
    }

    return res.json({ ok:true, member_id: m.member_id, handle: m.handle, color_hex: m.color_hex, image_key: m.image_key });
  } catch (e) {
    console.error('[qh.upsert]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});


module.exports = router;
