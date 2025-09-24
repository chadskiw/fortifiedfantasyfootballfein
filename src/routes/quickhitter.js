// routes/quickhitter.js
// Enforces: member_id (8 chars [0-9A-Z]) required for upsert,
// quick_snap unique, (handle,color_hex) unique pair.
// Stores image_key only (no CDN base). Public GETs by handle or swid.

const express = require('express');
const pool    = require('../../src/db/pool'); // adjust path if your pool is elsewhere
const router  = express.Router();

const HANDLE_RE = /^[A-Za-z0-9_.]{3,24}$/;
const MID_RE    = /^[0-9A-Z]{8}$/;
const HEX_RE    = /^[0-9A-Fa-f]{6}$/;

const R2_BASE = process.env.R2_PUBLIC_BASE || 'https://img.fortifiedfantasy.com';

const norm = v => String(v ?? '').trim();
const normHandle = v => {
  const s = norm(v);
  return HANDLE_RE.test(s) ? s : '';
};
const normHex = v => {
  const s = norm(v).replace(/^#/, '');
  return HEX_RE.test(s) ? s.toUpperCase() : '';
};
const normMemberId = v => {
  const s = norm(v).toUpperCase();
  return MID_RE.test(s) ? s : '';
};
const normSwid = v => {
  const s = norm(v).toUpperCase().replace(/[{}]/g, '');
  return s ? `{${s}}` : '';
};
const fullUrl = key => {
  key = norm(key).replace(/^\/+/, '');
  return key ? `${R2_BASE}/${key}` : null;
};

// ---------- Public reads ----------

// GET /api/quickhitter/:handle
router.get('/:handle', async (req, res) => {
  try {
    const handle = normHandle(req.params.handle);
    if (!handle) return res.status(400).json({ ok:false, error:'invalid_handle' });

    const { rows } = await pool.query(
      `SELECT member_id, handle, quick_snap, image_key, color_hex, updated_at
         FROM ff_quickhitter
        WHERE LOWER(handle)=LOWER($1)
        LIMIT 1`,
      [handle]
    );
    if (!rows[0]) return res.status(404).json({ ok:false, error:'not_found' });

    const r = rows[0];
    res.json({
      ok: true,
      member_id: r.member_id,
      handle: r.handle,
      quick_snap: r.quick_snap || null,
      color_hex: r.color_hex || null,
      image_key: r.image_key || null,
      image_url: fullUrl(r.image_key),
      updated_at: r.updated_at
    });
  } catch (e) {
    console.error('[quickhitter:get]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/quickhitter/by-swid/:swid
router.get('/by-swid/:swid', async (req, res) => {
  try {
    const swid = normSwid(req.params.swid);
    if (!swid) return res.status(400).json({ ok:false, error:'invalid_swid' });

    const { rows } = await pool.query(
      `SELECT member_id, handle, quick_snap, image_key, color_hex, updated_at
         FROM ff_quickhitter
        WHERE LOWER(quick_snap)=LOWER($1)
        LIMIT 1`,
      [swid]
    );
    if (!rows[0]) return res.status(404).json({ ok:false, error:'not_found' });

    const r = rows[0];
    res.json({
      ok: true,
      member_id: r.member_id,
      handle: r.handle,
      quick_snap: r.quick_snap || null,
      color_hex: r.color_hex || null,
      image_key: r.image_key || null,
      image_url: fullUrl(r.image_key),
      updated_at: r.updated_at
    });
  } catch (e) {
    console.error('[quickhitter:by-swid]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- Upsert (owner writes) ----------
// POST /api/quickhitter/upsert
// body: { member_id, handle?, quick_snap?, image_key?, color_hex? }
router.post('/upsert', express.json(), async (req, res) => {
  try {
    const member_id = normMemberId(req.body?.member_id || req.cookies?.ff_member);
    if (!member_id) return res.status(422).json({ ok:false, error:'invalid_member_id' });

    const handle     = req.body?.handle    ? normHandle(req.body.handle) : null;
    const quick_snap = req.body?.quick_snap? normSwid(req.body.quick_snap) : null;
    const image_key  = req.body?.image_key ? norm(req.body.image_key).replace(/^\/+/, '') : null;
    const color_hex  = req.body?.color_hex ? normHex(req.body.color_hex) : null;

    // optional sanity
    if (req.body?.handle && !handle)     return res.status(422).json({ ok:false, error:'invalid_handle' });
    if (req.body?.color_hex && !color_hex) return res.status(422).json({ ok:false, error:'invalid_color_hex' });

    // Upsert by member_id
    const params = [member_id, handle, quick_snap, image_key, color_hex];
    const sql = `
      INSERT INTO ff_quickhitter (member_id, handle, quick_snap, image_key, color_hex)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (member_id)
      DO UPDATE SET
        handle     = COALESCE(EXCLUDED.handle,     ff_quickhitter.handle),
        quick_snap = COALESCE(EXCLUDED.quick_snap, ff_quickhitter.quick_snap),
        image_key  = COALESCE(EXCLUDED.image_key,  ff_quickhitter.image_key),
        color_hex  = COALESCE(EXCLUDED.color_hex,  ff_quickhitter.color_hex)
      RETURNING member_id, handle, quick_snap, image_key, color_hex, updated_at
    `;

    let row;
    try {
      const r = await pool.query(sql, params);
      row = r.rows[0];
    } catch (e) {
      // Map unique violations to clean 409s
      if (String(e.code) === '23505') {
        const msg = String(e.detail || '').toLowerCase();
        if (msg.includes('ff_quickhitter_quicksnap_lower_uq')) {
          return res.status(409).json({ ok:false, error:'quick_snap_taken' });
        }
        if (msg.includes('ff_quickhitter_handle_color_uq')) {
          return res.status(409).json({ ok:false, error:'handle_color_taken' });
        }
        if (msg.includes('ff_quickhitter_member_id_uq')) {
          // unlikely here due to ON CONFLICT, but included for completeness
          return res.status(409).json({ ok:false, error:'member_id_taken' });
        }
      }
      console.error('[quickhitter:upsert]', e);
      return res.status(500).json({ ok:false, error:'server_error' });
    }

    return res.json({
      ok: true,
      member_id: row.member_id,
      handle: row.handle || null,
      quick_snap: row.quick_snap || null,
      color_hex: row.color_hex || null,
      image_key: row.image_key || null,
      image_url: fullUrl(row.image_key),
      updated_at: row.updated_at
    });
  } catch (e) {
    console.error('[quickhitter:upsert:outer]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
