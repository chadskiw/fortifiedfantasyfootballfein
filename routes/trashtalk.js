// routes/trashtalk.js
const express = require('express');
const multer = require('multer');
const exifr = require('exifr'); // make sure this is installed: npm i exifr
const { uploadToR2 } = require('../services/r2Client');
const { headR2 } = require('../services/r2Client'); // at top, next to uploadToR2

const { pool } = require('../src/db');

// ...
const router = express.Router();

const EARTH_RADIUS_M = 6371000; // meters

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

/**
 * POST /api/trashtalk/upload
 * Upload photos, parse EXIF, stash in R2 + tt_photo.
 */
router.post(
  '/upload',
  upload.array('photos', 100),
  async (req, res) => {
    try {
      const memberId = (req.user && req.user.member_id) || req.body.member_id;

      if (!memberId) {
        return res.status(400).json({ error: 'member_id required' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
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
        } catch (err) {
        console.warn('EXIF parse failed for', file.originalname, err.message);
        }

        const timestamp = getImageTimestamp(exifData); // ← from metadata when possible
        const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
        const r2Key = `trashtalk/${memberId}/${timestamp}_${safeName}`;


        await uploadToR2({
          key: r2Key,
          body: file.buffer,
          contentType: file.mimetype,
        });

const takenAt = new Date(timestamp);

const insertQuery = `
  INSERT INTO tt_photo (
    member_id,
    r2_key,
    original_filename,
    mime_type,
    exif,
    lat,
    lon,
    taken_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING photo_id, member_id, r2_key, created_at, lat, lon, taken_at;
`;

const { rows } = await pool.query(insertQuery, [
  memberId,
  r2Key,
  file.originalname,
  file.mimetype,
  exifData ? JSON.stringify(exifData) : null,
  lat,
  lon,
  takenAt,
]);


        results.push(rows[0]);
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
    member_id,
    r2_key,
    original_filename,
    mime_type,
    created_at,
    taken_at,          -- ← add this
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

module.exports = router;
