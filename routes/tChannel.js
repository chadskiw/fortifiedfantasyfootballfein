// routes/tChannel.js
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../db/pool'); // this is your pgPool

// Hard-coded channel slug for now; adjust if you want to support more later
const ALLOWED_KYO_SLUG = 'KeigoMoriyama'; // from ?kyo=KeigoMoriyama

// Serve the channel page HTML
// GET /t?kyo=KeigoMoriyama
router.get('/t', (req, res) => {
  const filePath = path.join(__dirname, '../public/trashtalk/t.html');
  return res.sendFile(filePath);
});

/**
 * POST /api/t/kyo/login
 * Body: { kyo: "KeigoMoriyama" }
 *
 * If kyo matches ALLOWED_KYO_SLUG, we look up ff_quickhitter by handle
 * and set ff_member_id cookie to that member_id.
 * This is a TEMPORARY magic-login helper, not production security.
 */
router.post('/api/t/kyo/login', express.json(), async (req, res) => {
  try {
    const { kyo } = req.body || {};

    if (!kyo) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    if (kyo !== ALLOWED_KYO_SLUG) {
      // For now, only allow magic login for this one slug
      return res.status(403).json({ ok: false, error: 'unauthorized_channel' });
    }

    // Find the member by handle (you can flip to member_id if you prefer)
    const { rows } = await pool.query(
      `SELECT member_id, handle, color_hex
       FROM ff_quickhitter
       WHERE handle = $1
       LIMIT 1`,
      [kyo]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: 'member_not_found',
        message: `No ff_quickhitter row with handle='${kyo}'`
      });
    }

    const { member_id, handle, color_hex } = rows[0];

    // TEMPORARY: magic login via cookie
    // This is convenient for onboarding but not secure for production.
    res.cookie('ff_member_id', member_id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
      path: '/'
    });

    return res.json({
      ok: true,
      mode: 'owner',
      member_id,
      handle,
      color_hex
    });
  } catch (err) {
    console.error('/api/t/kyo/login error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/t/channel?kyo=KeigoMoriyama&viewerId=PUBGHOST
 *
 * Returns channel metadata + photos for the host.
 * ViewerId is just passed through for now (you can use later for analytics / gating).
 */
router.get('/api/t/channel', async (req, res) => {
  try {
    const { kyo, viewerId } = req.query;

    if (!kyo) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle, color_hex
       FROM ff_quickhitter
       WHERE handle = $1
       LIMIT 1`,
      [kyo]
    );

    if (!hostRows.length) {
      return res.status(404).json({
        ok: false,
        error: 'host_not_found',
        message: `No ff_quickhitter row with handle='${kyo}'`
      });
    }

    const host = hostRows[0];

    // Pull photos for that member_id – tweak ORDER / LIMIT as you like
    const { rows: photoRows } = await pool.query(
      `
      SELECT
        photo_id,
        member_id,
        r2_key,
        lat,
        lon,
        taken_at,
        created_at,
        exif
      FROM tt_photo
      WHERE member_id = $1
      ORDER BY taken_at DESC NULLS LAST, created_at DESC
      LIMIT 200
      `,
      [host.member_id]
    );

    return res.json({
      ok: true,
      channel: {
        kyo,
        viewerId: viewerId || null,
        host_member_id: host.member_id,
        handle: host.handle,
        color_hex: host.color_hex,
        photo_count: photoRows.length
      },
      photos: photoRows
    });
  } catch (err) {
    console.error('/api/t/channel error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
