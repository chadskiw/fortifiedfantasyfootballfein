// routes/trashtalk.js
const express = require('express');
const multer = require('multer');
const exifr = require('exifr'); // make sure this is installed: npm i exifr
const { uploadToR2, headR2, deleteFromR2 } = require('../services/r2Client');
const { getCurrentIdentity } = require('../services/identity');

const { pool } = require('../src/db');

// ...
const router = express.Router();

const EARTH_RADIUS_M = 6371000; // meters
const VALID_AUDIENCES = new Set(['private', 'public', 'party']);
const DEFAULT_AUDIENCE = 'private';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

/**
 * Helper: normalize EXIF GPS to decimal lat/lon if possible.
 * exifr typically gives latitude/longitude as decimal numbers already.
 */
function extractLatLon(exifData) {
  if (!exifData) return { lat: null, lon: null };

  let lat = null;
  let lon = null;

  // Preferred: exifr's normalized values
  if (typeof exifData.latitude === 'number') lat = exifData.latitude;
  if (typeof exifData.longitude === 'number') lon = exifData.longitude;

  // Fallbacks if needed – keep light, we can expand later if EXIF is weird
  if (lat == null && typeof exifData.lat === 'number') lat = exifData.lat;
  if (lon == null && typeof exifData.lon === 'number') lon = exifData.lon;

  return { lat, lon };
}
function getImageTimestamp(exifData) {
  if (!exifData) return Date.now();

  // exifr usually gives these as Date objects if it can parse them
  const candidates = [
    exifData.CreateDate,
    exifData.DateTimeOriginal,
    exifData.DateCreated,
    exifData.ModifyDate,
  ];

  for (const c of candidates) {
    if (!c) continue;

    // If it's already a Date object
    if (c instanceof Date) {
      const t = c.getTime();
      if (!Number.isNaN(t)) return t;
    }

    // If it's a string like "2025:11:29 14:32:10"
    if (typeof c === 'string') {
      const d = new Date(c.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
      const t = d.getTime();
      if (!Number.isNaN(t)) return t;
    }
  }

  // Fallback if nothing usable
  return Date.now();
}
function getCameraFingerprint(exifData) {
  if (!exifData) return null;

  const parts = [
    exifData.Make,
    exifData.Model,
    exifData.LensModel,
  ]
    .filter(Boolean)
    .join('|')
    .trim();

  return parts || null;
}
/**
 * Haversine distance calculation in SQL:
 * We'll inline the math in the query. This function just returns the snippet.
 */
function haversineSql(latParam, lonParam, latCol = 'lat', lonCol = 'lon') {
  // latParam / lonParam will be bind params like $1, $2
  return `
    ${EARTH_RADIUS_M} * acos(
      cos(radians(${latParam})) * cos(radians(${latCol})) *
      cos(radians(${lonCol}) - radians(${lonParam})) +
      sin(radians(${latParam})) * sin(radians(${latCol}))
    )
  `;
}

async function ensurePartyUploadAccess(partyId, handle) {
  if (!partyId) return { ok: true };

  const { rows: partyRows } = await pool.query(
    'SELECT party_id, state FROM tt_party WHERE party_id = $1 LIMIT 1',
    [partyId]
  );
  if (!partyRows.length) {
    return { ok: false, status: 404, error: 'party_not_found' };
  }
  if (partyRows[0].state === 'cut') {
    return { ok: false, status: 410, error: 'party_cut' };
  }

  const { rows: membershipRows } = await pool.query(
    `
      SELECT access_level
        FROM tt_party_member
       WHERE party_id = $1
         AND handle = $2
       LIMIT 1
    `,
    [partyId, handle]
  );

  if (
    !membershipRows.length ||
    membershipRows[0].access_level !== 'live'
  ) {
    return { ok: false, status: 403, error: 'live_access_required' };
  }

  return {
    ok: true,
    party: partyRows[0],
    membership: membershipRows[0],
  };
}

function resolveAudience(requested, hasParty) {
  if (hasParty) return 'party';
  if (!requested) return DEFAULT_AUDIENCE;
  const normalized = String(requested).toLowerCase();
  if (normalized === 'party') return hasParty ? 'party' : DEFAULT_AUDIENCE;
  if (VALID_AUDIENCES.has(normalized)) return normalized;
  return DEFAULT_AUDIENCE;
}

/**
 * POST /api/trashtalk/upload
 * Upload photos, parse EXIF, stash in R2 + tt_photo.
 */
let cameraFingerprint = null;
router.post(
  '/upload',
  upload.array('photos', 100),
  async (req, res) => {
    try {
      const me = await getCurrentIdentity(req, pool);
      if (!me || !me.handle) {
        return res.status(401).json({ error: 'handle_required' });
      }
      const ownerHandle = me.handle;
      const ownerMemberId = me.memberId || me.member_id || null;

      const rawParty = req.body?.partyId ?? req.body?.party_id ?? null;
      const partyId =
        rawParty && String(rawParty).trim() ? String(rawParty).trim() : null;
      const requestedAudience = req.body?.audience;
      const audience = resolveAudience(requestedAudience, Boolean(partyId));

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      if (partyId) {
        const access = await ensurePartyUploadAccess(partyId, ownerHandle);
        if (!access.ok) {
          return res
            .status(access.status || 400)
            .json({ error: access.error || 'party_upload_not_allowed' });
        }
      }


      const results = [];

      for (const file of req.files) {
        if (!file.mimetype.startsWith('image/')) continue;

        let exifData = null;
        let lat = null;
        let lon = null;

        try {
        exifData = await exifr.parse(file.buffer);
        const coords = extractLatLon(exifData);
        lat = coords.lat;
        lon = coords.lon;
        cameraFingerprint = getCameraFingerprint(exifData);
        } catch (err) {
        console.warn('EXIF parse failed for', file.originalname, err.message);
        }

        const timestamp = getImageTimestamp(exifData); // ← from metadata when possible
        const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
        const r2Key = `trashtalk/${ownerHandle}/${timestamp}_${safeName}`;


        await uploadToR2({
          key: r2Key,
          body: file.buffer,
          contentType: file.mimetype,
        });

const takenAt = new Date(timestamp);

const upsertValues = [
  ownerHandle,           // $1
  r2Key,                 // $2
  ownerMemberId,         // $3
  file.originalname,     // $4
  file.mimetype,         // $5
  exifData ? JSON.stringify(exifData) : null, // $6
  lat,                   // $7
  lon,                   // $8
  takenAt,               // $9
  cameraFingerprint,     // $10
  partyId,               // $11
  audience               // $12
];

const existing = await pool.query(
  `
    SELECT photo_id
      FROM tt_photo
     WHERE handle = $1
       AND r2_key = $2
     LIMIT 1;
  `,
  [ownerHandle, r2Key]
);

let row;
if (existing.rows.length) {
  const updateQuery = `
    UPDATE tt_photo AS t
       SET member_id          = COALESCE(t.member_id, $3),
           original_filename  = COALESCE(t.original_filename, $4),
           mime_type          = $5,
           exif               = COALESCE(t.exif, $6),
           lat                = $7,
           lon                = $8,
           taken_at           = COALESCE(t.taken_at, $9),
           camera_fingerprint = COALESCE(t.camera_fingerprint, $10),
           party_id           = COALESCE($11, t.party_id),
           audience           = COALESCE($12, t.audience)
     WHERE t.photo_id = $13
       AND t.handle = $1
       AND t.r2_key = $2
     RETURNING photo_id,
              handle,
              r2_key,
              created_at,
              lat,
              lon,
              taken_at,
              camera_fingerprint,
              party_id,
              audience;
  `;

  const updateValues = [...upsertValues, existing.rows[0].photo_id];
  const { rows } = await pool.query(updateQuery, updateValues);
  row = rows[0];
} else {
  const insertQuery = `
    INSERT INTO tt_photo (
      handle,
      r2_key,
      member_id,
      original_filename,
      mime_type,
      exif,
      lat,
      lon,
      taken_at, 
      camera_fingerprint,
      party_id,
      audience
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING photo_id,
              handle,
              r2_key,
              created_at,
              lat,
              lon,
              taken_at,
              camera_fingerprint,
              party_id,
              audience;
  `;

  const { rows } = await pool.query(insertQuery, upsertValues);
  row = rows[0];
}

        if (row) {
          results.push(row);
        }
      }

      return res.status(201).json({
        uploaded: results.length,
        photos: results,
      });
    } catch (err) {
      console.error('TrashTalk upload error', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/trashtalk/nearby?lat=..&lon=..&radiusMeters=..
 *
 * Returns photos whose GPS is within radiusMeters of the provided point,
 * newest first.
 */
router.get('/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radiusMeters = parseFloat(req.query.radiusMeters) || 150; // default 150m

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon query params required' });
    }

    const distanceExpr = haversineSql('$1', '$2');

const sql = `
  SELECT
    photo_id,
    handle,
    r2_key,
    original_filename,
    mime_type,
    created_at,
    taken_at,
    lat,
    lon,
    ${distanceExpr} AS distance_m
  FROM tt_photo
  WHERE
    lat IS NOT NULL
    AND lon IS NOT NULL
    AND ${distanceExpr} <= $3
  ORDER BY distance_m, taken_at DESC
  LIMIT 200;
`;


    const { rows } = await pool.query(sql, [lat, lon, radiusMeters]);

    return res.json({
      lat,
      lon,
      radiusMeters,
      total: rows.length,
      photos: rows,
    });
  } catch (err) {
    console.error('TrashTalk nearby error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/debug/latest-object', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r2_key
         FROM tt_photo
        WHERE r2_key IS NOT NULL
        ORDER BY taken_at DESC
        LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No photos in DB yet' });
    }

    const key = rows[0].r2_key;

    try {
      const head = await headR2({ key });
      return res.json({
        ok: true,
        key,
        existsInR2: true,
        contentLength: head.ContentLength,
        contentType: head.ContentType,
      });
    } catch (err) {
      console.error('[TrashTalk] headR2 error', err);
      return res.status(500).json({
        ok: false,
        key,
        existsInR2: false,
        message: err.message,
      });
    }
  } catch (err) {
    console.error('[TrashTalk] debug latest-object error', err);
    return res.status(500).json({ error: 'debug failed' });
  }
});
// GET /api/trashtalk/map?minLat=&maxLat=&minLon=&maxLon=&zoom=
router.get('/map', async (req, res) => {
  try {
    const minLat = parseFloat(req.query.minLat);
    const maxLat = parseFloat(req.query.maxLat);
    const minLon = parseFloat(req.query.minLon);
    const maxLon = parseFloat(req.query.maxLon);
    const zoom = parseInt(req.query.zoom, 10) || 4;

    if (
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLat) ||
      !Number.isFinite(minLon) ||
      !Number.isFinite(maxLon)
    ) {
      return res.status(400).json({ error: 'minLat, maxLat, minLon, maxLon required' });
    }

    // Simple safety clamp: don’t blow up at world scale
    const MAX_RETURN = zoom <= 3 ? 300 : zoom <= 6 ? 800 : 2000;

  const sql = `
      SELECT
        photo_id,
        handle,
        r2_key,
        original_filename,
        mime_type,
        lat,
        lon,
        taken_at,
        created_at
      FROM tt_photo
      WHERE
        lat IS NOT NULL
        AND lon IS NOT NULL
        AND lat BETWEEN $1 AND $2
        AND lon BETWEEN $3 AND $4
      ORDER BY taken_at DESC NULLS LAST, created_at DESC
      LIMIT $5;
    `;

    const { rows } = await pool.query(sql, [
      minLat,
      maxLat,
      minLon,
      maxLon,
      MAX_RETURN,
    ]);

    return res.json({
      zoom,
      count: rows.length,
      photos: rows,
    });
  } catch (err) {
    console.error('TrashTalk map error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/photo/:photoId', async (req, res) => {
  try {
    const photoId = parseInt(req.params.photoId, 10);
    if (!Number.isFinite(photoId)) {
      return res.status(400).json({ error: 'Invalid photo id.' });
    }

    const me = await getCurrentIdentity(req, pool);
    if (!me || !me.handle) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const { rows } = await pool.query(
      `
        DELETE FROM tt_photo
        WHERE photo_id = $1
          AND handle = $2
        RETURNING photo_id, r2_key;
      `,
      [photoId, me.handle]
    );

      if (!rows.length) {
        return res.status(404).json({ error: 'Photo not found.' });
      }

      const r2Key = rows[0].r2_key;
      if (r2Key) {
        try {
          await deleteFromR2({ key: r2Key });
        } catch (r2Err) {
          console.error('TrashTalk delete R2 object error', {
            key: r2Key,
            photoId,
            handle: me.handle,
            message: r2Err.message,
          });
        }
      }

    return res.json({ deleted: true, photo_id: photoId });
  } catch (err) {
    console.error('TrashTalk delete photo error', err);
    return res.status(500).json({ error: 'Failed to delete photo.' });
  }
});

module.exports = router;
