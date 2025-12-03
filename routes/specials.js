const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth'); // adjust path if needed

// --- Helper: approximate distance in meters (Haversine)
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * POST /api/party/:partyId/specials
 * Create a new special for a party (host-only)
 */
router.post('/api/party/:partyId/specials', requireAuth, async (req, res) => {
  const partyId = req.params.partyId;
  const memberId = req.user.member_id;
  const {
    title,
    subtitle,
    specialType,
    startsAt,
    endsAt,
    isActive,
    businessId
  } = req.body || {};

  if (!title || !specialType) {
    return res.status(400).json({ error: 'title and specialType are required' });
  }

  try {
    // 1) Verify party + host
    const party = await req.db.oneOrNone(
      `
      SELECT party_id, host_member_id, name
        FROM tt_party
       WHERE party_id = $1
      `,
      [partyId]
    );
    if (!party) {
      return res.status(404).json({ error: 'Party not found' });
    }
    if (party.host_member_id !== memberId) {
      return res.status(403).json({ error: 'Only host can create specials' });
    }

    const finalBusinessId = businessId || party.host_member_id;

    // 2) Insert special
    const special = await req.db.one(
      `
      INSERT INTO tt_business_special (
        party_id,
        business_id,
        title,
        subtitle,
        special_type,
        starts_at,
        ends_at,
        created_by,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, true))
      RETURNING special_id, party_id, business_id, title, subtitle,
                special_type, starts_at, ends_at, is_active, created_at
      `,
      [
        partyId,
        finalBusinessId,
        title,
        subtitle || null,
        specialType,
        startsAt ? new Date(startsAt) : null,
        endsAt ? new Date(endsAt) : null,
        memberId,
        typeof isActive === 'boolean' ? isActive : true
      ]
    );

    return res.json({ ok: true, special });
  } catch (err) {
    console.error('[specials:create] error:', err);
    return res.status(500).json({ error: 'Unable to create special' });
  }
});

/**
 * GET /api/specials/nearby?lat=&lon=&radius_m=
 * Returns active specials around a point, filtered by muted businesses for this user.
 */
router.get('/api/specials/nearby', requireAuth, async (req, res) => {
  const memberId = req.user.member_id; // you can make this optional later
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  let radiusM = parseFloat(req.query.radius_m);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    radiusM = 2000; // default 2km
  }

  // degrees per meter approximations
  const degLat = radiusM / 111320; // 1 deg lat ~ 111.32km
  const latRad = (lat * Math.PI) / 180;
  const degLon = radiusM / (111320 * Math.cos(latRad) || 0.00001);

  try {
    const rows = await req.db.any(
      `
      SELECT
        s.special_id,
        s.party_id,
        s.business_id,
        s.title,
        s.subtitle,
        s.special_type,
        s.starts_at,
        s.ends_at,
        s.is_active,
        p.name AS business_name,
        p.center_lat,
        p.center_lon
      FROM tt_business_special s
      JOIN tt_party p
        ON p.party_id = s.party_id
      LEFT JOIN tt_member_business_mute mbm
        ON mbm.business_id = s.business_id
       AND mbm.member_id = $5
      WHERE s.is_active = true
        AND (s.starts_at IS NULL OR s.starts_at <= now())
        AND (s.ends_at IS NULL OR s.ends_at >= now())
        AND p.center_lat BETWEEN $1 - $3 AND $1 + $3
        AND p.center_lon BETWEEN $2 - $4 AND $2 + $4
        AND (mbm.business_id IS NULL)  -- not muted by this member
      `,
      [lat, lon, degLat, degLon, memberId]
    );

    const specials = rows.map((row) => {
      const distance_m = haversineMeters(
        lat,
        lon,
        row.center_lat,
        row.center_lon
      );
      return {
        special_id: row.special_id,
        party_id: row.party_id,
        business_id: row.business_id,
        business_name: row.business_name,
        title: row.title,
        subtitle: row.subtitle,
        special_type: row.special_type,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        lat: row.center_lat,
        lon: row.center_lon,
        distance_m
      };
    });

    // Optionally sort by distance ascending
    specials.sort((a, b) => a.distance_m - b.distance_m);

    return res.json(specials);
  } catch (err) {
    console.error('[specials:nearby] error:', err);
    return res.status(500).json({ error: 'Unable to fetch specials' });
  }
});

/**
 * POST /api/business/:businessId/mute
 * Mute a business for the current member
 */
router.post('/api/business/:businessId/mute', requireAuth, async (req, res) => {
  const memberId = req.user.member_id;
  const businessId = req.params.businessId;

  if (!businessId) {
    return res.status(400).json({ error: 'Missing businessId' });
  }

  try {
    await req.db.none(
      `
      INSERT INTO tt_member_business_mute (member_id, business_id)
      VALUES ($1, $2)
      ON CONFLICT (member_id, business_id) DO NOTHING
      `,
      [memberId, businessId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[business:mute] error:', err);
    return res.status(500).json({ error: 'Unable to mute business' });
  }
});

module.exports = router;
