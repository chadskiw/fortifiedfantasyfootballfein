// routes/sensor.js
const express = require('express');
const router = express.Router();
const pool = require('../src/db/pool'); // adjust path if needed

/**
 * Expect req.app.get('db') to be a pg.Pool or pg.Client
 * like you do in other routes.
 */

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

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

    // Upsert device
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

  // 👇 13 placeholders to match 13 values
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

// Simple debug/heartbeat
router.get('/heartbeat', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
  });
});

module.exports = router;
