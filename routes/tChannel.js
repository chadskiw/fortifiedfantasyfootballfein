// routes/tChannel.js
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../src/db/pool'); // <- this matches your pool.js
const https = require('https'); // at top of file if not already
// Hard-coded channel slug for now
const ALLOWED_KYO_SLUG = 'KeigoMoriyama';
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEATHER_MODES = new Set(['clear', 'rain', 'snow', 'storm', 'cloudy']);

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
function mapStudioNoteRow(row) {
  if (!row || typeof row !== 'object') return row;
  const payload = row.payload || {};
  return {
    note_id: row.note_id,
    sort_order: row.sort_order,
    is_active: row.is_active,
    created_at: row.created_at,
    ...payload,          // merges label, value, note_type, lat, lon, etc.
  };
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
  const normalized = slug.trim();
  if (!normalized) return null;
  const { rows } = await pool.query(
    `SELECT handle FROM ff_quickhitter WHERE lower(handle) = lower($1) LIMIT 1`,
    [normalized]
  );
  if (rows[0]) return rows[0];
  const { rows: partyRows } = await pool.query(
    `SELECT host_handle AS handle FROM tt_party WHERE lower(host_handle) = lower($1) LIMIT 1`,
    [normalized]
  );
  if (partyRows[0]) return partyRows[0];
  if (normalized.toLowerCase() === ALLOWED_KYO_SLUG.toLowerCase()) {
    return { handle: ALLOWED_KYO_SLUG };
  }
  return null;
}

async function fetchHostMemberRecord(handle) {
  if (!handle) return null;
  const { rows } = await pool.query(
    `SELECT member_id, handle
       FROM ff_quickhitter
      WHERE lower(handle) = lower($1)
      LIMIT 1`,
    [handle]
  );
  return rows[0] || null;
}

function sanitizeWeatherMode(mode) {
  const candidate = (mode || '').toString().trim().toLowerCase();
  return WEATHER_MODES.has(candidate) ? candidate : null;
}

function shapeOverridePayload(row) {
  if (!row) return null;
  return {
    mu_mode: row.mu_mode,
    label: row.label || 'Artist cue',
    description: row.description || '',
    source: 'override',
    updated_by_member_id: row.updated_by_member_id || null,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

async function selectWeatherOverride(channelHandle) {
  const { rows } = await pool.query(
    `
    SELECT
      channel_slug,
      mu_mode,
      label,
      description,
      updated_by_member_id,
      updated_at,
      expires_at
    FROM tt_tokyo_weather_override
    WHERE channel_slug = $1
    LIMIT 1
    `,
    [channelHandle]
  );
  if (!rows.length) {
    return null;
  }
  const override = rows[0];
  if (override.expires_at && new Date(override.expires_at) < new Date()) {
    return null;
  }
  return shapeOverridePayload(override);
}

async function upsertWeatherOverride(channelHandle, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO tt_tokyo_weather_override (
      channel_slug,
      mu_mode,
      label,
      description,
      updated_by_member_id,
      expires_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (channel_slug)
    DO UPDATE SET
      mu_mode = EXCLUDED.mu_mode,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      updated_by_member_id = EXCLUDED.updated_by_member_id,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
    RETURNING channel_slug, mu_mode, label, description, updated_by_member_id, updated_at, expires_at;
    `,
    [
      channelHandle,
      payload.mu_mode,
      payload.label || null,
      payload.description || null,
      payload.updated_by_member_id || null,
      payload.expires_at || null,
    ]
  );
  return shapeOverridePayload(rows[0]);
}

async function deleteWeatherOverride(channelHandle) {
  await pool.query(`DELETE FROM tt_tokyo_weather_override WHERE channel_slug = $1`, [
    channelHandle,
  ]);
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
//   GET  /api/t/guestbook
//   POST /api/t/guestbook
//   POST /api/t/links
//   DELETE /api/t/links/:id
//

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

// GET /api/t/weather?kyo=KeigoMoriyama
router.get('/weather', async (req, res) => {
  try {
    const channelSlug = normalizeSlug(req.query?.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelHandle = hostInfo.handle;

    const override = await selectWeatherOverride(channelHandle);
    if (override) {
      return res.json({ ok: true, weather: override });
    }

    // Option A: use party center_lat/center_lon if present
    const { rows: partyRows } = await pool.query(
      `
      SELECT center_lat, center_lon
      FROM tt_party
      WHERE host_handle = $1
      ORDER BY (state = 'open') DESC, starts_at DESC
      LIMIT 1
      `,
      [hostInfo.handle]
    );

    let lat = null;
    let lon = null;
    if (partyRows[0]) {
      lat = Number(partyRows[0].center_lat);
      lon = Number(partyRows[0].center_lon);
    }

    // Option B fallback: hard-code Shibuya if no party row
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      lat = 35.6595; // Shibuya
      lon = 139.7005;
    }

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      return res.json({
        ok: true,
        weather: {
          mu_mode: 'clear',
          label: 'Default clear',
          description: 'Live weather not configured; showing default cue.',
          source: 'system',
        },
      });
    }

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&appid=${encodeURIComponent(
      apiKey
    )}&units=metric`;

    const weatherRaw = await fetchJson(url);

    // Normalize result for front-end
    const firstWeather = (weatherRaw.weather && weatherRaw.weather[0]) || {};
    const main = firstWeather.main || '';
    const description = firstWeather.description || '';
    const icon = firstWeather.icon || '';
    const tempC = weatherRaw.main ? weatherRaw.main.temp : null;

    const condition = main.toLowerCase();

    // Map to a simple “Mu mode”
    let muMode = 'clear';
    if (condition.includes('rain') || condition.includes('drizzle')) {
      muMode = 'rain';
    } else if (condition.includes('snow')) {
      muMode = 'snow';
    } else if (condition.includes('thunder')) {
      muMode = 'storm';
    } else if (condition.includes('cloud')) {
      muMode = 'cloudy';
    }

    return res.json({
      ok: true,
      weather: {
        main,
        description,
        icon,
        temp_c: tempC,
        mu_mode: muMode,
        source: 'live',
      },
    });
  } catch (err) {
    console.error('/api/t/weather error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/weather/override', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(body.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const hostRecord = await fetchHostMemberRecord(hostInfo.handle);
    if (!hostRecord) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== hostRecord.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const safeMode = sanitizeWeatherMode(body.mu_mode);
    if (!safeMode) {
      return res.status(400).json({ ok: false, error: 'invalid_mode' });
    }
    let expiresAt = null;
    if (body.expires_at) {
      const ts = new Date(body.expires_at);
      if (!Number.isNaN(ts.valueOf())) {
        expiresAt = ts;
      }
    } else if (body.ttl_minutes != null) {
      const ttl = Number(body.ttl_minutes);
      if (Number.isFinite(ttl)) {
        const clamped = Math.min(Math.max(ttl, 5), 24 * 60);
        expiresAt = new Date(Date.now() + clamped * 60 * 1000);
      }
    }
    const override = await upsertWeatherOverride(hostRecord.handle, {
      mu_mode: safeMode,
      label: trimText(body.label, 140),
      description: trimText(body.description, 400),
      updated_by_member_id: requesterId,
      expires_at: expiresAt,
    });
    return res.json({ ok: true, weather: override });
  } catch (err) {
    console.error('/api/t/weather/override POST error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.delete('/weather/override', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(req.query?.kyo || body.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const hostRecord = await fetchHostMemberRecord(hostInfo.handle);
    if (!hostRecord) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== hostRecord.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    await deleteWeatherOverride(hostRecord.handle);
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/t/weather/override DELETE error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

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
        party_type,
        vibe_hue,
        vibe_saturation,
        vibe_brightness,
        updated_at
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

    // 4) Load studio notes for this channel (if any)
    const { rows: studioRows } = await pool.query(
      `
      SELECT
        note_id,
        payload,
        sort_order,
        is_active,
        created_at
      FROM tt_tokyo_studio_note
      WHERE channel_slug = $1
        AND is_active = TRUE
      ORDER BY sort_order ASC, created_at ASC
      `,
      [host.handle]
    );
    const studioNotes = studioRows.map(mapStudioNoteRow);

    // 5) Load links for this member
    const { rows: linkRows } = await pool.query(
      `
      SELECT
        link_id,
        platform,
        url,
        sort_order,
        is_active,
        created_at
      FROM tt_member_link
      WHERE member_id = $1
        AND is_active = TRUE
      ORDER BY sort_order ASC, created_at ASC
      `,
      [host.member_id]
    );

    // 6) Shape the channel payload exactly how t.js expects it
const channel = {
  kyo,
  viewerId: viewerId || null,
  host_member_id: host.member_id,
  handle: host.handle,
  color_hex: host.color_hex,
  photo_count: photoRows.length,
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
    : null,
  studio_notes: studioNotes,    // 🔴 NEW
    links: linkRows
  };

  return res.json({
    ok: true,
    channel,
    vibe: partyRow
      ? {
          hue: partyRow.vibe_hue,
          saturation: partyRow.vibe_saturation,
          brightness: partyRow.vibe_brightness
        }
      : null,
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

/**
 * POST /api/t/links
 * Body: { kyo, platform, url }
 * Only the host (Keigo) can add links.
 *
 * Frontend expects: { ok, link }
 */
router.post('/links', express.json(), async (req, res) => {
  try {
    const { kyo, platform, url } = req.body || {};

    if (!kyo || !platform || !url) {
      return res
        .status(400)
        .json({ ok: false, error: 'missing_fields', missing: { kyo: !kyo, platform: !platform, url: !url } });
    }

    const channelSlug = normalizeSlug(kyo);

    // Find host by slug (case-insensitive)
    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle
         FROM ff_quickhitter
        WHERE lower(handle) = lower($1)
        LIMIT 1`,
      [channelSlug]
    );
    if (!hostRows.length) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const host = hostRows[0];

    // Only host can add links
    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== host.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const trimmedUrl = String(url).trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_url',
        message: 'URL must start with http:// or https://'
      });
    }

    const trimmedPlatform = trimText(platform, 100);

    const insertSql = `
      INSERT INTO tt_member_link (
        member_id,
        platform,
        url,
        sort_order,
        is_active
      )
      VALUES (
        $1,
        $2,
        $3,
        COALESCE(
          (SELECT MAX(sort_order) + 1 FROM tt_member_link WHERE member_id = $1),
          0
        ),
        TRUE
      )
      RETURNING link_id, platform, url, sort_order, is_active, created_at;
    `;

    const { rows: linkRows } = await pool.query(insertSql, [
      host.member_id,
      trimmedPlatform,
      trimmedUrl
    ]);

    return res.json({
      ok: true,
      link: linkRows[0]
    });
  } catch (err) {
    console.error('/api/t/links POST error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * DELETE /api/t/links/:id?kyo=...
 * Soft-deletes a link (is_active = false) for this member.
 *
 * Frontend expects: { ok, link }
 */
router.delete('/links/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { kyo } = req.query;

    if (!id || !kyo) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    const channelSlug = normalizeSlug(kyo);

    // Find host by slug
    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle
         FROM ff_quickhitter
        WHERE lower(handle) = lower($1)
        LIMIT 1`,
      [channelSlug]
    );
    if (!hostRows.length) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const host = hostRows[0];

    // Only host can delete links
    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== host.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { rows: deletedRows } = await pool.query(
      `
      UPDATE tt_member_link
         SET is_active = FALSE,
             updated_at = NOW()
       WHERE link_id = $1
         AND member_id = $2
       RETURNING link_id, platform, url, sort_order, is_active, created_at;
      `,
      [id, host.member_id]
    );

    if (!deletedRows.length) {
      return res.status(404).json({ ok: false, error: 'link_not_found' });
    }

    return res.json({
      ok: true,
      link: deletedRows[0]
    });
  } catch (err) {
    console.error('/api/t/links DELETE error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// POST /api/t/notes
// Body: { kyo, ...noteFields }  (no note_id for create)
// Returns: { ok, note }
router.post('/notes', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(body.kyo);
    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }

    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelKey = hostInfo.handle;

    // Look up host member_id
    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle
         FROM ff_quickhitter
        WHERE lower(handle) = lower($1)
        LIMIT 1`,
      [channelKey]
    );
    if (!hostRows.length) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const host = hostRows[0];

    // Only host can create notes
    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== host.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    // Build payload from all other fields
    const { kyo, note_id, ...payload } = body;
    if (!payload || Object.keys(payload).length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_note' });
    }

    let sortOrder = null;
    if (payload.sort_order != null) {
      const n = Number(payload.sort_order);
      if (Number.isFinite(n)) sortOrder = n;
    }

    const insertSql = `
      INSERT INTO tt_tokyo_studio_note (
        channel_slug,
        payload,
        sort_order,
        is_active
      )
      VALUES (
        $1,
        $2,
        COALESCE(
          $3,
          (SELECT MAX(sort_order) + 1 FROM tt_tokyo_studio_note WHERE channel_slug = $1),
          0
        ),
        TRUE
      )
      RETURNING note_id, payload, sort_order, is_active, created_at;
    `;

    const { rows } = await pool.query(insertSql, [
      channelKey,
      payload,
      sortOrder,
    ]);

    return res.json({
      ok: true,
      note: mapStudioNoteRow(rows[0]),
    });
  } catch (err) {
    console.error('/api/t/notes POST error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// PUT /api/t/notes/:noteId
// Body: { kyo, ...noteFields }
// Returns: { ok, note }
router.put('/notes/:noteId', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(body.kyo || req.query?.kyo);
    const noteId = req.params.noteId || body.note_id;

    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    if (!noteId) {
      return res.status(400).json({ ok: false, error: 'missing_note_id' });
    }

    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelKey = hostInfo.handle;

    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle
         FROM ff_quickhitter
        WHERE lower(handle) = lower($1)
        LIMIT 1`,
      [channelKey]
    );
    if (!hostRows.length) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const host = hostRows[0];

    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== host.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { kyo, note_id, ...payload } = body;
    if (!payload || Object.keys(payload).length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_note' });
    }

    let sortOrder = null;
    if (payload.sort_order != null) {
      const n = Number(payload.sort_order);
      if (Number.isFinite(n)) sortOrder = n;
    }

    const updateSql = `
      UPDATE tt_tokyo_studio_note
         SET payload = $3,
             sort_order = COALESCE($4, sort_order),
             updated_at = NOW()
       WHERE note_id = $1
         AND channel_slug = $2
       RETURNING note_id, payload, sort_order, is_active, created_at;
    `;

    const { rows } = await pool.query(updateSql, [
      noteId,
      channelKey,
      payload,
      sortOrder,
    ]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'note_not_found' });
    }

    return res.json({
      ok: true,
      note: mapStudioNoteRow(rows[0]),
    });
  } catch (err) {
    console.error('/api/t/notes PUT error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// DELETE /api/t/notes/:noteId
// Query/body: kyo
// Returns: { ok, note }
router.delete('/notes/:noteId', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const channelSlug = normalizeSlug(req.query?.kyo || body.kyo);
    const noteId = req.params.noteId || body.note_id;

    if (!channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing_kyo' });
    }
    if (!noteId) {
      return res.status(400).json({ ok: false, error: 'missing_note_id' });
    }

    const hostInfo = await ensureChannelExists(channelSlug);
    if (!hostInfo) {
      return res
        .status(404)
        .json({ ok: false, error: 'channel_not_found', kyo: channelSlug });
    }
    const channelKey = hostInfo.handle;

    const { rows: hostRows } = await pool.query(
      `SELECT member_id, handle
         FROM ff_quickhitter
        WHERE lower(handle) = lower($1)
        LIMIT 1`,
      [channelKey]
    );
    if (!hostRows.length) {
      return res.status(404).json({ ok: false, error: 'host_not_found' });
    }
    const host = hostRows[0];

    const requesterId = getViewerMemberId(req);
    if (!requesterId || requesterId !== host.member_id) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const deleteSql = `
      UPDATE tt_tokyo_studio_note
         SET is_active = FALSE,
             updated_at = NOW()
       WHERE note_id = $1
         AND channel_slug = $2
       RETURNING note_id, payload, sort_order, is_active, created_at;
    `;

    const { rows } = await pool.query(deleteSql, [noteId, channelKey]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'note_not_found' });
    }

    return res.json({
      ok: true,
      note: mapStudioNoteRow(rows[0]),
    });
  } catch (err) {
    console.error('/api/t/notes DELETE error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
