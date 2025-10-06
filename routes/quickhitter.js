// routes/quickhitter.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
// at top of routes/quickhitter.js
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('../routes/images/r2');      // or wherever your configured client is
const R2_BUCKET = process.env.R2_BUCKET;
// --- place near top of file ---
const path   = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
// --- add at top with other imports ---
const fs = require('fs');
router.use(express.json());

// ---------- DB pool ----------
let db = require('../src/db/pool'); // adjust if needed
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[pg] pool.query not available — check require path/export');
}

// small helper: map ext → mime
const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif'
};

// ===================================================================
// POST /api/quickhitter/upsert-avatar-r2
// Writes to R2 key: avatars/anon/<timestamp>-<rand>.<ext> (no re-encode)
// ===================================================================
// ===================================================================
// POST /api/quickhitter/upsert-avatar-r2
// Writes to R2: avatars/anon/<timestamp>-<rand>.<ext> (no re-encode)
// Returns { ok, image_key, url }
// ===================================================================
router.post('/upsert-avatar-r2', upload.single('avatar'), async (req, res) => {
  try {
    if (!R2_BUCKET) {
      return res.status(500).json({ ok: false, error: 'r2_not_configured' });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

    const ext = (path.extname(req.file.originalname) || '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return res.status(400).json({ ok: false, error: 'bad_type' });

    const key = `avatars/anon/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

    // Put object as-is (no sharp())
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    return res.json({ ok: true, image_key: key, url: toCdnUrl(key) });
  } catch (err) {
    console.error('[qh.upsert-avatar-r2]', err);
    res.status(500).json({ ok: false, error: 'upload_failed' });
  }
});

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

// ---- member_id helpers ----
const MID_RE = /^[A-Z0-9]{8}$/;
function makeMemberId() {
  const id = crypto.randomBytes(8).toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
  return (id || 'ABCDEFGH').padEnd(8, 'X');
}
function ensureMemberId(v) {
  const clean = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return MID_RE.test(clean) ? clean : makeMemberId();
}

const norm       = v => String(v || '').trim();
const normHex    = v => {
  const s = norm(v);
  if (!s || !HEX_RE.test(s)) return null;
  const up = s.replace('#','').toUpperCase();
  return '#' + up; // ALWAYS '#RRGGBB'
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
// helpers/swid.js
function normalizeSwid(raw) {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    // Ensure braces and uppercase UUID
    const m = decoded.match(/\{?([0-9a-fA-F-]{36})\}?/);
    if (!m) return null;
    return `{${m[1].toUpperCase()}}`;
  } catch {
    return null;
  }
}

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
    const up = String(r.color_hex || '').toUpperCase();
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
  return null; // none left
}

// ----- session + contact owner helpers -----
function getSessionMemberId(req) {
  return (req?.cookies?.ff_member && String(req.cookies.ff_member).trim()) || null;
}

async function ownerOfContact({ email, phone }) {
  if (!email && !phone) return null;

  if (email) {
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
      [String(email).toLowerCase()]
    );
    if (rows[0]?.member_id) return rows[0].member_id;
  }

  if (phone) {
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
      [String(phone)]
    );
    if (rows[0]?.member_id) return rows[0].member_id;
  }

  return null;
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

// GET /api/quickhitter/check
router.get('/check', async (req, res) => {
  try {
    const reasons = [];

    // 1) If member cookie exists, try it FIRST
    let cookieMember = norm(req.cookies?.ff_member || '');
    if (cookieMember) {
      const byCookie = await pool.query(
        `SELECT * FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
        [cookieMember]
      );
      const row = byCookie.rows[0];
      if (row) {
        reasons.push('cookie_match');
        const m = rowToMember(row);
        return res.json({ ok: true, member: m, complete: isComplete(m), linked: true, reasons });
      } else {
        // cookie is stale/bad — clear it and proceed to SWID
        reasons.push('cookie_stale_cleared');
        res.clearCookie('ff_member', { sameSite: 'Lax', secure: true });
        cookieMember = '';
      }
    }

    // 2) Try ESPN SWID (cookie or header)
    const rawSwid = req.cookies?.SWID || req.get('x-espn-swid');
    const swidBrace = normalizeSwid(rawSwid); // "{UUID}" uppercase
    if (!swidBrace) {
      reasons.push('no_swid');
      return res.json({ ok: true, complete: false, linked: false, reasons });
    }
    const swidUuid = swidBrace.slice(1, -1).toLowerCase(); // strip {}

    // 3) Find by quick_snap (text) OR swid (uuid)
    const { rows } = await pool.query(
      `
      SELECT *
        FROM ff_quickhitter
       WHERE quick_snap = $1
          OR swid = $2::uuid
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1
      `,
      [swidBrace, swidUuid]
    );
    const row = rows[0];
    if (!row) {
      reasons.push('swid_no_match');
      return res.json({ ok: true, complete: false, linked: false, reasons });
    }

    // 4) Backfill swid (uuid) if missing
    if (!row.swid) {
      await pool.query(
        `UPDATE ff_quickhitter SET swid = $1::uuid, updated_at = NOW() WHERE id = $2`,
        [swidUuid, row.id]
      );
      reasons.push('backfilled_swid');
    }

    // 5) Ensure the row has a member_id and persist it if not
    let memberId = row.member_id && String(row.member_id).trim();
    if (!memberId) {
      memberId = ensureMemberId(row.member_id);
      await pool.query(
        `UPDATE ff_quickhitter SET member_id = $1, updated_at = NOW() WHERE id = $2`,
        [memberId, row.id]
      );
      reasons.push('backfilled_member_id');
    }

    // 6) Set cookie for future requests
    // Make sure your app has: app.set('trust proxy', 1) when behind Cloudflare/Render
    res.cookie('ff_member', memberId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,     // stays true; 'trust proxy' ensures it works behind TLS terminator
      path: '/',
      // domain: '.fortifiedfantasy.com', // uncomment if you need to share across subdomains
    });

    const m = rowToMember({ ...row, member_id: memberId });
    reasons.push('swid_linked');
    return res.json({ ok: true, member: m, complete: isComplete(m), linked: true, reasons });
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
const E164_RE = /^\+[1-9]\d{7,14}$/;

function toE164(raw){
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g,'');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}

// POST /api/quickhitter/upsert
// helpers (place near top)
const readyForId = (handle, colorHex, email, phone) =>
  !!(handle && isHandleShape(handle) && normHex(colorHex) && (email || phone));



// ===================================================================
// POST /api/quickhitter/upsert
// form-data: avatar=@file.png
// Saves to /public/avatars/anon/<timestamp>_<rand>.<ext> (no re-encode)
// Returns { ok, image_key, url }
// ===================================================================
router.post('/upsert', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

    const ext = (path.extname(req.file.originalname) || '').toLowerCase();
    const validExts = new Set(['.png', '.jpg', '.jpeg', '.gif']);
    if (!validExts.has(ext)) {
      return res.status(400).json({ ok: false, error: 'bad_type' });
    }

    const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    const rel = path.join('avatars', 'anon', filename);
    const abs = path.join(__dirname, '..', 'public', rel);

    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, req.file.buffer); // no sharp(), no webp

    const image_key = rel.replace(/\\/g, '/');
    const url = `/${image_key}`;
    return res.json({ ok: true, image_key, url });
  } catch (err) {
    console.error('[qh.upsert]', err);
    res.status(500).json({ ok: false, error: 'upload_failed' });
  }
});






module.exports = router;
