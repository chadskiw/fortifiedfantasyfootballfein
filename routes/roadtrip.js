// routes/roadtrip.js
const express = require('express');
const pool = require('../src/db/pool'); // adjust path if your pool is elsewhere

const router = express.Router();

/**
 * GET /road
 * Usage: s1c.live/road?trip=TripName
 *
 * Looks up a roadtrip by:
 *   - trip_vanity (preferred), or
 *   - name (fallback, case-insensitive)
 */
router.get('/', async (req, res) => {
  const trip = req.query.trip;

  if (!trip) {
    return res.status(400).json({ ok: false, error: 'Missing trip parameter' });
  }

  try {
    const tripResult = await pool.query(
      `
      SELECT
        r.*,
        p.name       AS party_name,
        p.center_lat AS party_center_lat,
        p.center_lon AS party_center_lon
      FROM tt_party_roadtrip r
      LEFT JOIN tt_party p
        ON p.party_id = r.party_id
      WHERE
        (r.trip_vanity IS NOT NULL AND lower(r.trip_vanity) = lower($1))
        OR lower(r.name) = lower($1)
      LIMIT 1
      `,
      [trip]
    );

    if (tripResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Roadtrip not found' });
    }

    const roadtrip = tripResult.rows[0];

    // Fetch attached objects (hype / live drops / recap notes, etc.)
    const objectsPromise = pool.query(
      `
      SELECT
        o.*,
        m.handle
      FROM tt_party_roadtrip_object o
      LEFT JOIN ff_member m
        ON m.member_id = o.member_id
      WHERE o.roadtrip_id = $1
      ORDER BY o.at_time ASC NULLS LAST, o.object_id ASC
      `,
      [roadtrip.roadtrip_id]
    );

    // Fetch playlist(s) + tracks, if any
    const playlistPromise = pool.query(
      `
      SELECT
        pl.*,
        COALESCE(
          json_agg(tr ORDER BY tr.track_order)
            FILTER (WHERE tr.track_id IS NOT NULL),
          '[]'
        ) AS tracks
      FROM tt_party_roadtrip_playlist pl
      LEFT JOIN tt_party_roadtrip_playlist_track tr
        ON tr.playlist_id = pl.playlist_id
      WHERE pl.roadtrip_id = $1
      GROUP BY pl.playlist_id
      `,
      [roadtrip.roadtrip_id]
    );

    const [objectsResult, playlistResult] = await Promise.all([
      objectsPromise,
      playlistPromise
    ]);

    const payload = {
      ok: true,
      roadtrip,
      objects: objectsResult.rows,
      playlist: playlistResult.rows
    };

    const wantsJson =
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      req.query.format === 'json';

    if (wantsJson) {
      return res.json(payload);
    }

    // If you don’t use server-side views, you can:
    // - send HTML here, OR
    // - just always return JSON and let Cloudflare front-end consume it.
    //
    // For now, try to render a view called "roadtrip" if you have it:
    try {
      return res.render('roadtrip', {
        trip: payload.roadtrip,
        objects: payload.objects,
        playlist: payload.playlist
      });
    } catch (e) {
      // Fallback: JSON if no view exists
      return res.json(payload);
    }
  } catch (err) {
    console.error('Error in GET /road:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
