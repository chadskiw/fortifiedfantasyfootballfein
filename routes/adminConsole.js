// routes/adminConsole.js
const express = require('express');
const router = express.Router();
const pool = require('../src/db'); // adjust if your db helper is in a different path

// Try to get member_id from the request
function getMemberIdFromReq(req) {
  // If you already attach member info somewhere, use that first
  if (req.member && req.member.member_id) return req.member.member_id;
  if (req.user && req.user.member_id) return req.user.member_id;

  // Fallback: your ff_member_id cookie
  if (req.cookies && req.cookies.ff_member_id) return req.cookies.ff_member_id;

  return null;
}

// Only allow BADASS01 to hit these routes
function ensureAdmin(req, res, next) {
  const memberId = getMemberIdFromReq(req);

  if (memberId !== 'BADASS01') {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      message: 'Admin access only'
    });
  }

  next();
}

/**
 * GET /api/admin/members/map
 *
 * Returns all members with last known location and online/offline status.
 */
router.get('/members/map', ensureAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        member_id,
        handle,
        color_hex,
        last_latitude,
        last_longitude,
        last_location_updated_at,
        last_seen_at,
        location_state,
        (last_seen_at > NOW() - INTERVAL '2 minutes') AS is_online
      FROM ff_quickhitter
      WHERE last_latitude IS NOT NULL
        AND last_longitude IS NOT NULL
      ORDER BY last_seen_at DESC NULLS LAST
      `
    );

    res.json({
      ok: true,
      members: rows
    });
  } catch (err) {
    console.error('admin/members/map error:', err);
    res.status(500).json({
      ok: false,
      error: 'server_error'
    });
  }
});

module.exports = router;
