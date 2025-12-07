// routes/tChannel.js
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../src/db/pool'); // <- this matches your pool.js

// Hard-coded channel slug for now
const ALLOWED_KYO_SLUG = 'KeigoMoriyama';

// --- PAGE ROUTE ---------------------------------------------------------
// We want /t?kyo=KeigoMoriyama to serve t.html
// NOTE: this route will be mounted at '/' in server.js
router.get('/t', (req, res) => {
  const filePath = path.join(__dirname, '../public/trashtalk/t.html');
  return res.sendFile(filePath);
});

// --- API ROUTES ---------------------------------------------------------
// THESE ARE RELATIVE to /api/t mount, so final paths are:
//
//   POST /api/t/kyo/login
//   GET  /api/t/channel
//

/**
 * POST /api/t/kyo/login
 * Body: { kyo: "KeigoMoriyama" }
 */
router.post('/kyo/login', express.json(), async (req, res) => {
  try {
    const { kyo } = req.body || {};

    if (!kyo) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    if (kyo !== ALLOWED_KYO_SLUG) {
      // Only allow this one slug for now
      return res.status(403).json({ ok: false, error: 'unauthorized_channel' });
    }

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

    // TEMP: magic login helper
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
 */
router.get('/channel', async (req, res) => {
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
