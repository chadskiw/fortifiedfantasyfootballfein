// src/routes/quickhitter.js
const express = require('express');
const router = express.Router();
router.use(express.json({ limit: '2mb' }));

// ---- DB pool (works with either default or named export) ----
let db = require('../src/db/pool'); // adjust if your pool path differs
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[quickhitter] pg pool missing/invalid import');
}

const log = (...a) => console.log('[quickhitter]', ...a);

// ---------- helpers ----------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE  = /^\+[1-9]\d{7,14}$/; // ITU E.164

function toE164(raw){
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g,'');
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}

// Sanitize hex like #77E0FF -> 77E0FF
const normHex = s => (String(s||'').replace(/[^0-9A-Fa-f]/g,'').toUpperCase() || null);

// Build image URL (fallback handled client-side as /logo.png)
const toCdnUrl = key => key ? `https://img.fortifiedfantasy.com/${key}` : null;

// ---------- GET /api/quickhitter/check ----------
// Returns a merged view of the user's quickhitter (by cookie or temp member_id)
router.get('/check', async (req, res) => {
  try{
    const member_id = (req.cookies && req.cookies.ff_member) || (req.query && req.query.member_id) || (req.headers['x-ff-member-id']) || null;

    const row = member_id
      ? await pool.query(
          `SELECT id, member_id, handle, image_key, color_hex, email, email_is_verified, phone, phone_is_verified, fb_groups
             FROM ff_quickhitter
            WHERE member_id = $1
            ORDER BY id DESC
            LIMIT 1`,
          [member_id]
        )
      : { rows: [] };

    const m = row.rows[0] || null;
    return res.json({
      ok: true,
      member: m && {
        ...m,
        image_url: toCdnUrl(m.image_key),
      }
    });
  }catch(e){
    log('check error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- POST /api/quickhitter/upsert ----------
// Stages the pre-signup info. No verified contact required to SAVE.
// Validates email/phone formats; rejects with 422 instead of tripping DB constraints.
router.post('/upsert', async (req, res) => {
  try{
    const b = req.body || {};
    const member_id = (b.member_id || '').trim() || (req.cookies && String(req.cookies.ff_member||'').trim()) || null;
    const handle    = (b.handle || '').trim() || null;
    const color_hex = normHex(b.color_hex);
    const image_key = (b.image_key || null);

    const emailRaw  = b.email ? String(b.email).trim() : null;
    const phoneRaw  = b.phone ? String(b.phone).trim() : null;

    // Normalize + validate
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    const phone = phoneRaw ? toE164(phoneRaw) : null;

    if (email && !EMAIL_RE.test(email)) {
      return res.status(422).json({ ok:false, error:'invalid_email', message:'Email looks invalid.' });
    }
    if (phone && !E164_RE.test(phone)) {
      return res.status(422).json({ ok:false, error:'invalid_phone', message:'Phone must be E.164 like +15551231234.' });
    }

    if (!member_id) {
      // create a temp member_id if you want, or require it. For now, require it:
      return res.status(400).json({ ok:false, error:'missing_member_id' });
    }

    // Check for ownership conflicts (email/phone already tied to a different quickhitter/member)
    if (email) {
      const dupe = await pool.query(
        `SELECT member_id FROM ff_quickhitter
          WHERE deleted_at IS NULL AND LOWER(email)=LOWER($1) AND member_id <> $2
          LIMIT 1`,
        [email, member_id]
      );
      if (dupe.rows[0]) {
        return res.status(409).json({ ok:false, error:'contact_belongs_to_other', kind:'email' });
      }
    }
    if (phone) {
      const dupe = await pool.query(
        `SELECT member_id FROM ff_quickhitter
          WHERE deleted_at IS NULL AND phone=$1 AND member_id <> $2
          LIMIT 1`,
        [phone, member_id]
      );
      if (dupe.rows[0]) {
        return res.status(409).json({ ok:false, error:'contact_belongs_to_other', kind:'phone' });
      }
    }

    // Upsert
    const { rows } = await pool.query(
      `
      INSERT INTO ff_quickhitter (member_id, handle, image_key, color_hex, email, phone)
      VALUES ($1,$2,$3,$4,
              COALESCE($5, NULLIF(email,'')),
              COALESCE($6, NULLIF(phone,'')))
      ON CONFLICT (member_id) DO UPDATE SET
        handle    = COALESCE(EXCLUDED.handle, ff_quickhitter.handle),
        image_key = COALESCE(EXCLUDED.image_key, ff_quickhitter.image_key),
        color_hex = COALESCE(EXCLUDED.color_hex, ff_quickhitter.color_hex),
        email     = COALESCE(EXCLUDED.email, ff_quickhitter.email),
        phone     = COALESCE(EXCLUDED.phone, ff_quickhitter.phone),
        updated_at= NOW()
      RETURNING id, member_id, handle, image_key, color_hex, email, email_is_verified, phone, phone_is_verified, fb_groups, updated_at
      `,
      [member_id, handle, image_key, color_hex, email, phone]
    );

    const row = rows[0];
    return res.json({
      ok: true,
      member: {
        ...row,
        image_url: toCdnUrl(row.image_key),
      }
    });
  }catch(e){
    log('upsert error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
