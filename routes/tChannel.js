// routes/tChannel.js
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../src/db/pool'); // <- this matches your pool.js

// Hard-coded channel slug for now
const ALLOWED_KYO_SLUG = 'KeigoMoriyama';
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSlug(value) {
  return (value || '').toString().trim();
}

function trimText(value, max = 1024) {
  if (!value) return '';
  return value.toString().trim().slice(0, max);
}

function coerceNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getViewerMemberId(req) {
  return (
    req.ff_member_id ||
    req.cookies?.ff_member_id ||
    req.cookies?.ff_member ||
    req.user?.member_id ||
    null
  );
}

function mapGuestbookRow(row) {
  if (!row || typeof row !== 'object') return row;
  const normalized = { ...row };
  if (normalized.lat != null) normalized.lat = Number(normalized.lat);
  if (normalized.lon != null) normalized.lon = Number(normalized.lon);
  if (normalized.location_accuracy_m != null) {
    normalized.location_accuracy_m = Number(normalized.location_accuracy_m);
  }
  return normalized;
}

function generateGuestId() {
  return `GUEST-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

async function ensureChannelExists(slug) {
  if (!slug) return null;
  const { rows } = await pool.query(
    `SELECT handle FROM ff_quickhitter WHERE lower(handle) = lower($1) LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

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
// GET /api/t/channel?kyo=KeigoMoriyama&viewerId=PUBGHOST
router.get('/channel', async (req, res) => {
  try {
    const { kyo, viewerId } = req.query;

    if (!kyo) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    // 1) Look up host in ff_quickhitter
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

    // 2) Find an associated party for this host (latest OPEN party)
    const { rows: partyRows } = await pool.query(
      `
      SELECT
        party_id,
        name,
        description,
        center_lat,
        center_lon,
        starts_at,
        ends_at,
        state,
        visibility_mode,
        party_type
      FROM tt_party
      WHERE host_member_id = $1
      ORDER BY
        (state = 'open') DESC,
        starts_at DESC
      LIMIT 1
      `,
      [host.member_id]
    );

    const partyRow = partyRows[0] || null;

    // 3) Load photos for this member
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

    // 4) Shape the channel payload exactly how t.js expects it
    const channel = {
      kyo,
      viewerId: viewerId || null,
      host_member_id: host.member_id,
      handle: host.handle,
      color_hex: host.color_hex,
      photo_count: photoRows.length,
      // NEW: active party info in the shapes t.js already looks at
      active_party_id: partyRow ? partyRow.party_id : null,
      party: partyRow
        ? {
            party_id: partyRow.party_id,
            name: partyRow.name,
            description: partyRow.description,
            center_lat: partyRow.center_lat,
            center_lon: partyRow.center_lon,
            starts_at: partyRow.starts_at,
            ends_at: partyRow.ends_at,
            state: partyRow.state,
            visibility_mode: partyRow.visibility_mode,
            party_type: partyRow.party_type
          }
        : null
    };

    return res.json({
      ok: true,
      channel,
      photos: photoRows
    });
  } catch (err) {
    console.error('/api/t/channel error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/t/guestbook?kyo=KeigoMoriyama
 */
router.get('/guestbook', async (req, res) => {
  try {
    const channelSlug = normalizeSlug(req.query?.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    const host = await ensureChannelExists(channelSlug);
    if (!host) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelKey = host.handle;
    const limitParam = Number(req.query?.limit);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), 100)
      : 30;
    const { rows } = await pool.query(
      `
      SELECT
        entry_id,
        channel_slug,
        guest_id,
        guest_label,
        viewer_member_id,
        party_id,
        message,
        email,
        phone,
        lat,
        lon,
        location_source,
        location_accuracy_m,
        created_at
      FROM tt_tokyo_guestbook
      WHERE channel_slug = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [channelKey, limit]
    );
    return res.json({
      ok: true,
      entries: rows.map(mapGuestbookRow),
    });
  } catch (err) {
    console.error('/api/t/guestbook list error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/t/guestbook
 */
router.post('/guestbook', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(body.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    const host = await ensureChannelExists(channelSlug);
    if (!host) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelKey = host.handle;
    const message = trimText(body.message, 2000);
    if (!message) {
      return res.status(400).json({ ok: false, error: 'missing_message' });
    }
    if (message.length < 2) {
      return res.status(400).json({ ok: false, error: 'message_too_short' });
    }
    const viewerMemberId =
      trimText(body.viewer_member_id || getViewerMemberId(req), 64) || null;
    let guestId =
      trimText(body.guest_id, 64) ||
      viewerMemberId ||
      trimText(req.cookies?.viewer_id, 64);
    if (!guestId) {
      guestId = generateGuestId();
    }
    const guestLabel =
      trimText(body.guest_label, 80) || viewerMemberId || guestId;
    const partyId =
      typeof body.party_id === 'string' && UUID_REGEX.test(body.party_id)
        ? body.party_id
        : null;
    const lat = coerceNumber(body.lat);
    const lon = coerceNumber(body.lon);
    const locationSource = trimText(body.location_source, 64) || null;
    const locationAccuracy =
      coerceNumber(body.location_accuracy ?? body.location_accuracy_m) || null;
    const email = trimText(body.contact_email, 160) || null;
    const phone = trimText(body.contact_phone, 40) || null;

    const { rows } = await pool.query(
      `
      INSERT INTO tt_tokyo_guestbook (
        channel_slug,
        guest_id,
        guest_label,
        viewer_member_id,
        party_id,
        message,
        email,
        phone,
        lat,
        lon,
        location_source,
        location_accuracy_m
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING
        entry_id,
        channel_slug,
        guest_id,
        guest_label,
        viewer_member_id,
        party_id,
        message,
        email,
        phone,
        lat,
        lon,
        location_source,
        location_accuracy_m,
        created_at
      `,
      [
        channelKey,
        guestId,
        guestLabel,
        viewerMemberId,
        partyId,
        message,
        email,
        phone,
        lat,
        lon,
        locationSource,
        locationAccuracy,
      ]
    );
    return res.status(201).json({
      ok: true,
      entry: mapGuestbookRow(rows[0]),
    });
  } catch (err) {
    console.error('/api/t/guestbook create error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});


module.exports = router;
