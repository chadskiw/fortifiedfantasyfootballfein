// routes/sensor.js
const express = require('express');
const router = express.Router();
const pool = require('../src/db/pool'); // adjust path if needed

/**
 * DB: expects tables
 *
 * s1c_sensor_device (
 *   device_id TEXT PRIMARY KEY,
 *   member_id TEXT NOT NULL,
 *   platform  TEXT NOT NULL,
 *   label     TEXT,
 *   created_at TIMESTAMPTZ DEFAULT now(),
 *   last_seen_at TIMESTAMPTZ DEFAULT now()
 * )
 *
 * s1c_sensor_point (
 *   sensor_point_id BIGSERIAL PRIMARY KEY,
 *   device_id  TEXT NOT NULL REFERENCES s1c_sensor_device(device_id) ON DELETE CASCADE,
 *   member_id  TEXT NOT NULL,
 *   trip_id    TEXT,
 *   recorded_at TIMESTAMPTZ NOT NULL,
 *   lat        DOUBLE PRECISION NOT NULL,
 *   lon        DOUBLE PRECISION NOT NULL,
 *   accuracy_m DOUBLE PRECISION,
 *   speed_mps  DOUBLE PRECISION,
 *   heading_deg DOUBLE PRECISION,
 *   accel_x    DOUBLE PRECISION,
 *   accel_y    DOUBLE PRECISION,
 *   accel_z    DOUBLE PRECISION,
 *   raw_payload JSONB,
 *   created_at TIMESTAMPTZ DEFAULT now()
 * );
 */

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Ingest batched sensor points from the app
router.post('/batch', async (req, res) => {
  const db = pool;

  try {
    const {
      device_id,
      member_id,
      platform,
      label,
      trip_id,
      points,
    } = req.body || {};

    if (!device_id || !member_id || !platform || !Array.isArray(points) || points.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_payload',
        message: 'device_id, member_id, platform, and non-empty points[] are required',
      });
    }

    // Upsert device row
    await db.query(
      `
      INSERT INTO s1c_sensor_device (device_id, member_id, platform, label)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (device_id) DO UPDATE
        SET member_id    = EXCLUDED.member_id,
            platform     = EXCLUDED.platform,
            label        = COALESCE(EXCLUDED.label, s1c_sensor_device.label),
            last_seen_at = NOW()
      `,
      [device_id, member_id, platform, label || null],
    );

    const values = [];
    let idx = 1;
    const placeholders = [];

    for (const p of points) {
      if (!p || !isFiniteNumber(p.lat) || !isFiniteNumber(p.lon) || !p.t) {
        continue;
      }

      const recordedAt = new Date(p.t);
      if (Number.isNaN(recordedAt.getTime())) {
        continue;
      }

      const accuracy_m = isFiniteNumber(p.accuracy_m) ? p.accuracy_m : null;
      const speed_mps = isFiniteNumber(p.speed_mps) ? p.speed_mps : null;
      const heading_deg = isFiniteNumber(p.heading_deg) ? p.heading_deg : null;
      const accel_x = p.accel && isFiniteNumber(p.accel.x) ? p.accel.x : null;
      const accel_y = p.accel && isFiniteNumber(p.accel.y) ? p.accel.y : null;
      const accel_z = p.accel && isFiniteNumber(p.accel.z) ? p.accel.z : null;
      const raw_payload = p || null;

      // 13 placeholders to match 13 values
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, ` +
        `$${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, ` +
        `$${idx++}, $${idx++}, $${idx++})`,
      );

      values.push(
        device_id,                // 1
        member_id,                // 2
        trip_id || null,          // 3
        recordedAt.toISOString(), // 4
        p.lat,                    // 5
        p.lon,                    // 6
        accuracy_m,               // 7
        speed_mps,                // 8
        heading_deg,              // 9
        accel_x,                  // 10
        accel_y,                  // 11
        accel_z,                  // 12
        raw_payload,              // 13
      );
    }

    if (placeholders.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no_valid_points',
      });
    }

    const insertSql = `
      INSERT INTO s1c_sensor_point (
        device_id,
        member_id,
        trip_id,
        recorded_at,
        lat,
        lon,
        accuracy_m,
        speed_mps,
        heading_deg,
        accel_x,
        accel_y,
        accel_z,
        raw_payload
      )
      VALUES ${placeholders.join(', ')}
    `;

    await db.query(insertSql, values);

    return res.json({
      ok: true,
      stored: placeholders.length,
      device_id,
    });
  } catch (err) {
    console.error('[sensor.batch] error', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
    });
  }
});

/**
 * GET /api/sensor/path?trip_id=dubbaby2[&member_id=BADASS01][&max_points=500]
 *
 * Returns simplified ordered path for a trip:
 * {
 *   ok: true,
 *   points: [{ lat, lon, t }, ...]
 * }
 */
router.get('/path', async (req, res) => {
  const db = pool;

  try {
    const { trip_id, member_id } = req.query;
    if (!trip_id) {
      return res.status(400).json({
        ok: false,
        error: 'missing_trip_id',
      });
    }

    let maxPoints = parseInt(req.query.max_points, 10);
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      maxPoints = 500; // sane default
    } else if (maxPoints > 5000) {
      maxPoints = 5000; // hard cap
    }

    const params = [trip_id];
    let where = 'trip_id = $1';

    if (member_id) {
      params.push(member_id);
      where += ' AND member_id = $2';
    }

    const sql = `
      SELECT
        lat,
        lon,
        recorded_at AS t
      FROM s1c_sensor_point
      WHERE ${where}
      ORDER BY recorded_at ASC
    `;

    const { rows } = await db.query(sql, params);

    if (!rows.length) {
      return res.json({
        ok: true,
        points: [],
      });
    }

    // Downsample in JS if too many points
    let pts = rows;
    if (rows.length > maxPoints) {
      const step = Math.ceil(rows.length / maxPoints);
      const down = [];
      for (let i = 0; i < rows.length; i += step) {
        down.push(rows[i]);
      }
      // ensure last point is included
      const last = rows[rows.length - 1];
      if (down[down.length - 1] !== last) {
        down.push(last);
      }
      pts = down;
    }

    return res.json({
      ok: true,
      points: pts,
    });
  } catch (err) {
    console.error('[sensor.path] error', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
    });
  }
});

// Simple debug/heartbeat
router.get('/heartbeat', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
  });
});

module.exports = router;
