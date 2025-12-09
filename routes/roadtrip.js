// routes/roadtrip.js
const express = require('express');
const pool = require('../src/db/pool'); // adjust path if needed
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();

/**
 * Helper: slugify trip name -> trip_vanity
 */
function slugifyTripName(name) {
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Helper: compute distance of planned_path (simple haversine)
 * plannedPath = [{lat, lon}, ...]
 */
function distanceOfPlannedPath(plannedPath) {
  if (!Array.isArray(plannedPath) || plannedPath.length < 2) return 0;

  const R = 6371e3; // meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  let total = 0;
  for (let i = 1; i < plannedPath.length; i++) {
    const a = plannedPath[i - 1];
    const b = plannedPath[i];
    if (
      typeof a.lat !== 'number' ||
      typeof a.lon !== 'number' ||
      typeof b.lat !== 'number' ||
      typeof b.lon !== 'number'
    ) {
      continue;
    }
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLat = lat2 - lat1;
    const dLon = toRad(b.lon - a.lon);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
      sinDLat * sinDLat +
      Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    total += R * c;
  }
  return Math.round(total);
}

function normalizePlannedPath(plannedPath) {
  if (!Array.isArray(plannedPath) || plannedPath.length === 0) {
    return null;
  }

  const normalized = plannedPath
    .map((pt, idx) => {
      if (!pt) return null;
      const lat = Number(pt.lat ?? pt.latitude);
      const lon = Number(pt.lon ?? pt.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const seq =
        typeof pt.seq === 'number'
          ? pt.seq
          : typeof pt.order_index === 'number'
          ? pt.order_index
          : idx + 1;
      return { lat, lon, seq };
    })
    .filter(Boolean);

  return normalized.length ? normalized : null;
}

async function ensureRoadtripHost(req, res, roadtripId) {
  let actorMemberId = null;
  try {
    actorMemberId = await resolveMemberId(req);
  } catch (err) {
    console.error('[roadtrip] host resolution failed', err);
  }

  if (!actorMemberId) {
    res.status(401).json({
      ok: false,
      error: 'Not authenticated: host_member_id missing',
    });
    return null;
  }

  let roadtripRow = null;
  try {
    const { rows } = await pool.query(
      `SELECT roadtrip_id, party_id, host_member_id FROM tt_party_roadtrip WHERE roadtrip_id = $1 LIMIT 1`,
      [roadtripId]
    );
    roadtripRow = rows[0] || null;
  } catch (err) {
    console.error('[roadtrip] roadtrip lookup failed', err);
    res.status(500).json({
      ok: false,
      error: 'Unable to load roadtrip',
    });
    return null;
  }

  if (!roadtripRow) {
    res.status(404).json({
      ok: false,
      error: 'Roadtrip not found',
    });
    return null;
  }

  const normalizedHostId = roadtripRow.host_member_id
    ? String(roadtripRow.host_member_id)
    : null;

  if (
    normalizedHostId &&
    normalizedHostId !== String(actorMemberId)
  ) {
    res.status(403).json({
      ok: false,
      error: 'Only the party host can modify this roadtrip',
    });
    return null;
  }

  return {
    actorMemberId: String(actorMemberId),
    roadtrip: roadtripRow,
  };
}

const ROADTRIP_OBJECT_KINDS = new Set([
  'planned_hype',
  'live_drop',
  'recap_note',
]);

const hasOwn = (obj, key) =>
  Object.prototype.hasOwnProperty.call(obj || {}, key);

async function resolveMemberId(req) {
  const inline =
    req.member_id ||
    req.ffMemberId ||
    (req.ffMember && req.ffMember.member_id) ||
    req.headers?.['x-ff-member-id'];
  if (inline) return String(inline);

  const cookieMemberId =
    req.cookies?.ff_member_id ||
    req.cookies?.ff_member ||
    null;
  if (cookieMemberId) return String(cookieMemberId);

  try {
    const identity = await getCurrentIdentity(req, pool);
    if (identity?.member_id) return String(identity.member_id);
  } catch (err) {
    console.warn('[roadtrip] identity lookup failed', err.message);
  }
  return null;
}

/**
 * POST /api/roadtrip
 * Create a new roadtrip tied to a Party.
 *
 * Body:
 * {
 *   party_id: UUID,
 *   name: string,
 *   description?: string,
 *   trip_vanity?: string,
 *   starts_at?: ISO string,
 *   ends_at?: ISO string,
 *   planned_path?: [{lat, lon, seq?}, ...]
 * }
 */
router.post('/', async (req, res) => {
  const {
    party_id,
    name,
    description,
    trip_vanity,
    starts_at,
    ends_at,
    planned_path,
  } = req.body || {};

  if (!party_id || !name) {
    return res.status(400).json({
      ok: false,
      error: 'party_id and name are required',
    });
  }

  let actorMemberId = null;
  try {
    actorMemberId = await resolveMemberId(req);
  } catch (err) {
    console.error('[roadtrip] failed to resolve member', err);
  }

  if (!actorMemberId) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated: host_member_id missing',
    });
  }

  let partyRow = null;
  try {
    const { rows } = await pool.query(
      `SELECT party_id, host_member_id FROM tt_party WHERE party_id = $1 LIMIT 1`,
      [party_id]
    );
    partyRow = rows[0] || null;
  } catch (err) {
    console.error('[roadtrip] party lookup failed', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to verify party host',
    });
  }

  if (!partyRow) {
    return res.status(404).json({
      ok: false,
      error: 'Party not found',
    });
  }

  const normalizedPartyHostId = partyRow.host_member_id
    ? String(partyRow.host_member_id)
    : null;

  if (
    normalizedPartyHostId &&
    normalizedPartyHostId !== String(actorMemberId)
  ) {
    return res.status(403).json({
      ok: false,
      error: 'Only the party host can create a roadtrip for this party',
    });
  }

  const hostMemberId = normalizedPartyHostId || String(actorMemberId);

  // Normalize planned_path: keep only {lat, lon, seq}
  const normalizedPath = normalizePlannedPath(planned_path);

  const plannedDistanceM = normalizedPath
    ? distanceOfPlannedPath(normalizedPath)
    : null;

  // Vanity slug
  let vanity = (trip_vanity || '').trim();
  if (!vanity) {
    vanity = slugifyTripName(name);
  }

  try {
    const insertResult = await pool.query(
      `
      INSERT INTO tt_party_roadtrip (
        roadtrip_id,
        party_id,
        host_member_id,
        name,
        description,
        trip_vanity,
        state,
        planned_path,
        planned_distance_m,
        starts_at,
        ends_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        'planning',
        $6,
        $7,
        $8,
        $9
      )
      RETURNING *
      `,
      [
        party_id,
        hostMemberId,
        name,
        description || null,
        vanity || null,
        normalizedPath ? JSON.stringify(normalizedPath) : null,
        plannedDistanceM,
        starts_at || null,
        ends_at || null,
      ]
    );

    const roadtrip = insertResult.rows[0];

    return res.status(201).json({
      ok: true,
      roadtrip,
    });
  } catch (err) {
    console.error('Error creating roadtrip:', err);

    // Handle unique violation on trip_vanity nicely
    if (err.code === '23505' && err.constraint && err.constraint.includes('trip_vanity')) {
      return res.status(409).json({
        ok: false,
        error: 'That trip slug is already in use. Try a different trip_vanity.',
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'Failed to create roadtrip',
    });
  }
});

/**
 * GET /api/roadtrip?trip=TripName
 * Look up a roadtrip by vanity or name, plus objects + playlist
 */
router.get('/', async (req, res) => {
  const trip = (req.query.trip || '').trim();

  if (!trip) {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing trip parameter' });
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
      return res
        .status(404)
        .json({ ok: false, error: 'Roadtrip not found' });
    }

    const roadtrip = tripResult.rows[0];

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
      playlistPromise,
    ]);

    return res.json({
      ok: true,
      roadtrip,
      objects: objectsResult.rows,
      playlist: playlistResult.rows,
    });
  } catch (err) {
    console.error('Error in GET /api/roadtrip:', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Internal server error' });
  }
});

router.put('/:roadtripId/plan', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const payload = req.body || {};
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (typeof payload.name === 'string' && payload.name.trim()) {
    fields.push(`name = $${paramIndex++}`);
    values.push(payload.name.trim());
  }

  if (hasOwn(payload, 'description')) {
    fields.push(`description = $${paramIndex++}`);
    values.push(
      typeof payload.description === 'string' && payload.description.trim()
        ? payload.description.trim()
        : null
    );
  }

  if (hasOwn(payload, 'starts_at')) {
    fields.push(`starts_at = $${paramIndex++}`);
    values.push(payload.starts_at || null);
  }

  if (hasOwn(payload, 'ends_at')) {
    fields.push(`ends_at = $${paramIndex++}`);
    values.push(payload.ends_at || null);
  }

  if (hasOwn(payload, 'state')) {
    const normalizedState =
      typeof payload.state === 'string' && payload.state.trim()
        ? payload.state.trim().toLowerCase()
        : null;
    if (normalizedState) {
      fields.push(`state = $${paramIndex++}`);
      values.push(normalizedState);
    }
  }

  if (hasOwn(payload, 'planned_path')) {
    const normalizedPath = normalizePlannedPath(payload.planned_path);
    const plannedDistanceM = normalizedPath
      ? distanceOfPlannedPath(normalizedPath)
      : null;
    fields.push(`planned_path = $${paramIndex++}`);
    values.push(normalizedPath ? JSON.stringify(normalizedPath) : null);
    fields.push(`planned_distance_m = $${paramIndex++}`);
    values.push(plannedDistanceM);
  }

  if (!fields.length) {
    return res.status(400).json({
      ok: false,
      error: 'No updates provided for roadtrip plan',
    });
  }

  const query = `
    UPDATE tt_party_roadtrip
    SET ${fields.join(', ')}
    WHERE roadtrip_id = $${paramIndex}
    RETURNING *
  `;
  values.push(roadtripId);

  try {
    const { rows } = await pool.query(query, values);
    return res.json({
      ok: true,
      roadtrip: rows[0],
    });
  } catch (err) {
    console.error('[roadtrip] failed to update plan', err);
    return res.status(500).json({
      ok: false,
      error: 'Failed to update roadtrip plan',
    });
  }
});

router.post('/:roadtripId/objects', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const {
    kind,
    title,
    body,
    lat,
    lon,
    at_time,
    media_url,
    photo_url,
    image_url,
  } = req.body || {};

  const kindSlug =
    typeof kind === 'string' && kind.trim()
      ? kind.trim().toLowerCase()
      : 'planned_hype';
  const normalizedKind = ROADTRIP_OBJECT_KINDS.has(kindSlug)
    ? kindSlug
    : 'planned_hype';

  const latNumber =
    lat === undefined || lat === null || lat === ''
      ? null
      : Number(lat);
  if (latNumber !== null && !Number.isFinite(latNumber)) {
    return res.status(400).json({
      ok: false,
      error: 'lat must be a valid number',
    });
  }

  const lonNumber =
    lon === undefined || lon === null || lon === ''
      ? null
      : Number(lon);
  if (lonNumber !== null && !Number.isFinite(lonNumber)) {
    return res.status(400).json({
      ok: false,
      error: 'lon must be a valid number',
    });
  }

  let atTimeIso = null;
  if (at_time) {
    const parsed = new Date(at_time);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid at_time value',
      });
    }
    atTimeIso = parsed.toISOString();
  }

  const resolvedPhotoUrl =
    (typeof photo_url === 'string' && photo_url.trim()) ||
    (typeof media_url === 'string' && media_url.trim()) ||
    (typeof image_url === 'string' && image_url.trim()) ||
    null;

  if (
    !resolvedPhotoUrl &&
    (title === undefined || title === null || title === '') &&
    (body === undefined || body === null || body === '')
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Provide at least a title, body, or media_url',
    });
  }

  try {
    const insertResult = await pool.query(
      `
      INSERT INTO tt_party_roadtrip_object (
        object_id,
        roadtrip_id,
        member_id,
        kind,
        title,
        body,
        photo_url,
        lat,
        lon,
        at_time
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9
      )
      RETURNING *
      `,
      [
        roadtripId,
        hostContext.actorMemberId,
        normalizedKind,
        title || null,
        body || null,
        resolvedPhotoUrl,
        latNumber,
        lonNumber,
        atTimeIso,
      ]
    );

    return res.status(201).json({
      ok: true,
      object: insertResult.rows[0],
    });
  } catch (err) {
    console.error('[roadtrip] failed to insert object', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to record hype drop',
    });
  }
});

router.delete('/:roadtripId/objects/:objectId', async (req, res) => {
  const { roadtripId, objectId } = req.params || {};
  if (!roadtripId || !objectId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId and objectId params are required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  try {
    const result = await pool.query(
      `DELETE FROM tt_party_roadtrip_object WHERE roadtrip_id = $1 AND object_id = $2`,
      [roadtripId, objectId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        ok: false,
        error: 'Roadtrip object not found',
      });
    }

    return res.json({
      ok: true,
      deleted: result.rowCount,
    });
  } catch (err) {
    console.error('[roadtrip] failed to delete object', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to delete hype drop',
    });
  }
});

router.delete('/:roadtripId/objects', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const resetPlan =
    req.query?.reset_plan === '1' ||
    req.query?.reset_plan === 'true';

  let roadtripState = hostContext.roadtrip;

  let deleted = 0;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tt_party_roadtrip_object WHERE roadtrip_id = $1`,
      [roadtripId]
    );
    deleted = rowCount;
  } catch (err) {
    console.error('[roadtrip] failed to clear objects', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to clear hype drops',
    });
  }

  if (resetPlan) {
    try {
      const resetResult = await pool.query(
        `
        UPDATE tt_party_roadtrip
        SET planned_path = NULL,
            planned_distance_m = NULL,
            starts_at = NULL,
            ends_at = NULL
        WHERE roadtrip_id = $1
        RETURNING *
        `,
        [roadtripId]
      );
      if (resetResult.rows[0]) {
        roadtripState = resetResult.rows[0];
      }
    } catch (err) {
      console.error('[roadtrip] failed to reset plan during cleanup', err);
      return res.status(500).json({
        ok: false,
        error: 'Drops cleared but route reset failed',
      });
    }
  }

  return res.json({
    ok: true,
    deleted,
    roadtrip: roadtripState,
  });
});

module.exports = router;
