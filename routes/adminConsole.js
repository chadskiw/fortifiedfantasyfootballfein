// routes/adminConsole.js
const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../src/db'); // ⬅️ adjust if your db helper lives elsewhere

// Helper: extract member_id from request
function getMemberIdFromReq(req) {
  // If you already attach member info in middleware, prefer that
  if (req.member && req.member.member_id) return req.member.member_id;
  if (req.user && req.user.member_id) return req.user.member_id;

  // Fallback: cookie (this matches your ff_member_id cookie usage)
  if (req.cookies && req.cookies.ff_member_id) return req.cookies.ff_member_id;

  return null;
}

// Middleware: ensure this is BADASS01
function ensureAdmin(req, res, next) {
  const memberId = getMemberIdFromReq(req);

  if (memberId !== 'BADASS01') {
    return res.status(403).json({
      ok: false,
      error: 'forbidden',
      message: 'Admin access only'
    });
  }

  req.adminMemberId = memberId;
  next();
}

/**
 * GET /api/admin/members/map
 *
 * Returns all members with a last known location, plus online/offline status
 */
router.get('/admin/members/map', ensureAdmin, async (req, res) => {
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

/**
 * (Optional) Serve the admin console HTML from BE with check.
 * If you'd rather let Cloudflare serve the HTML, you can skip this
 * and only use the JSON endpoint above.
 */
router.get('/admin/console', ensureAdmin, (req, res) => {
  // Adjust path if you put the file elsewhere
  const filePath = path.join(__dirname, '../public/trashtalk/admin-console.html');
  res.sendFile(filePath);
});

module.exports = router;
