const { pool } = require('../src/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Infinity;
  }

  const R = 6371000;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isPointInPolygon(lat, lon, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lonI] = polygon[i] || [];
    const [latJ, lonJ] = polygon[j] || [];
    if (
      latI == null ||
      lonI == null ||
      latJ == null ||
      lonJ == null ||
      !Number.isFinite(latI) ||
      !Number.isFinite(lonI) ||
      !Number.isFinite(latJ) ||
      !Number.isFinite(lonJ)
    ) {
      continue;
    }

    const intersects =
      lonI > lon !== lonJ > lon &&
      lat <
        ((latJ - latI) * (lon - lonI)) / (lonJ - lonI + Number.EPSILON) + latI;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function isInZone(lat, lon, zone) {
  if (!zone || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }

  const shape = typeof zone.shape_type === 'string' ? zone.shape_type : '';
  if (shape === 'circle') {
    if (
      !Number.isFinite(zone.center_lat) ||
      !Number.isFinite(zone.center_lon) ||
      !Number.isFinite(zone.radius_m)
    ) {
      return false;
    }
    const dist = distanceMeters(lat, lon, zone.center_lat, zone.center_lon);
    return dist <= Number(zone.radius_m);
  }

  if (shape === 'polygon') {
    let points = null;
    if (Array.isArray(zone.polygon)) {
      points = zone.polygon;
    } else if (typeof zone.polygon === 'string') {
      try {
        points = JSON.parse(zone.polygon);
      } catch {
        points = null;
      }
    }
    return isPointInPolygon(lat, lon, points || []);
  }

  return false;
}

function normalizeZoneRow(row) {
  if (!row) return null;
  let polygon = null;
  if (Array.isArray(row.polygon)) {
    polygon = row.polygon;
  } else if (typeof row.polygon === 'string' && row.polygon.trim()) {
    try {
      polygon = JSON.parse(row.polygon);
    } catch {
      polygon = null;
    }
  }
  return {
    zone_id: row.zone_id,
    member_id: row.member_id,
    zone_label: row.zone_label,
    zone_kind: row.zone_kind || 'custom',
    shape_type: row.shape_type,
    center_lat: row.center_lat != null ? Number(row.center_lat) : null,
    center_lon: row.center_lon != null ? Number(row.center_lon) : null,
    radius_m: row.radius_m != null ? Number(row.radius_m) : null,
    polygon,
    obscure_for_strangers: row.obscure_for_strangers !== false,
    obscure_for_acquaint: row.obscure_for_acquaint === true,
    obscure_for_friends: row.obscure_for_friends === true,
    obscure_for_self: row.obscure_for_self === true,
    coarse_city: row.coarse_city || null,
    coarse_region: row.coarse_region || null,
    coarse_country: row.coarse_country || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadZonesForMembers(memberIds = [], db = pool) {
  const ids = Array.from(
    new Set(
      (Array.isArray(memberIds) ? memberIds : [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    )
  );

  if (!ids.length) {
    return new Map();
  }

  const { rows } = await db.query(
    `
      SELECT
        zone_id,
        member_id,
        zone_label,
        zone_kind,
        shape_type,
        center_lat,
        center_lon,
        radius_m,
        polygon,
        obscure_for_strangers,
        obscure_for_acquaint,
        obscure_for_friends,
        obscure_for_self,
        coarse_city,
        coarse_region,
        coarse_country,
        created_at,
        updated_at
      FROM tt_member_privacy_zone
      WHERE member_id = ANY($1::text[])
      ORDER BY updated_at DESC, created_at DESC
    `,
    [ids]
  );

  const map = new Map();
  rows.forEach((row) => {
    const normalized = normalizeZoneRow(row);
    if (!normalized) return;
    if (!map.has(normalized.member_id)) {
      map.set(normalized.member_id, []);
    }
    map.get(normalized.member_id).push(normalized);
  });
  return map;
}

const FRIEND_TYPES = new Set([
  'partner',
  'significant_other',
  'spouse',
  'husband',
  'wife',
  'fiance',
  'fiancee',
  'family',
  'parent',
  'child',
  'sibling',
  'inner_circle',
  'best_friend',
  'roommate',
  'roomie',
]);

const ACQUAINTANCE_TYPES = new Set([
  'friend',
  'coworker',
  'boss',
  'manager',
  'direct_report',
  'subordinate',
  'teacher',
  'student',
  'mentor',
  'mentee',
  'coach',
  'teammate',
  'neighbor',
  'landlord',
  'tenant',
  'client',
  'customer',
  'vendor',
  'service_provider',
  'business',
  'creator',
  'influencer',
  'fan',
  'acquaintance',
  'random',
]);

function normalizeTierKeyword(type) {
  if (!type || typeof type !== 'string') return 'acquaintance';
  const normalized = type.trim().toLowerCase();
  if (!normalized) return 'acquaintance';
  if (FRIEND_TYPES.has(normalized)) return 'friend';
  if (ACQUAINTANCE_TYPES.has(normalized)) return 'acquaintance';
  return 'acquaintance';
}

async function loadViewerRelationshipTiers(viewerId, ownerIds = [], db = pool) {
  const tiers = new Map();
  if (!viewerId) {
    return tiers;
  }

  const owners = Array.from(
    new Set(
      (Array.isArray(ownerIds) ? ownerIds : [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id && id !== viewerId)
    )
  );

  if (!owners.length) {
    return tiers;
  }

  const { rows } = await db.query(
    `
      SELECT
        member_id_from,
        member_id_to,
        relationship_type_from,
        relationship_type_to
      FROM tt_relationships_accepted
      WHERE status = 'active'
        AND (
          (member_id_from = $1 AND member_id_to = ANY($2::text[]))
          OR
          (member_id_to = $1 AND member_id_from = ANY($2::text[]))
        )
    `,
    [viewerId, owners]
  );

  rows.forEach((row) => {
    let ownerId;
    let type;
    if (row.member_id_from === viewerId) {
      ownerId = row.member_id_to;
      type = row.relationship_type_from;
    } else {
      ownerId = row.member_id_from;
      type = row.relationship_type_to;
    }
    if (!ownerId) return;
    tiers.set(ownerId, normalizeTierKeyword(type));
  });

  return tiers;
}

function shouldObscure(zone, viewerTier) {
  if (!zone) return false;
  switch (viewerTier) {
    case 'self':
      return zone.obscure_for_self === true;
    case 'friend':
      return zone.obscure_for_friends === true;
    case 'acquaintance':
      if (zone.obscure_for_acquaint === true) return true;
      return zone.obscure_for_strangers !== false;
    default:
      return zone.obscure_for_strangers !== false;
  }
}

function sanitizeItemForZone(item) {
  const copy = { ...item };
  if ('lat' in copy) copy.lat = null;
  if ('lon' in copy) copy.lon = null;
  if ('latitude' in copy) copy.latitude = null;
  if ('longitude' in copy) copy.longitude = null;
  return copy;
}

function applyPrivacyZones(items = [], options = {}) {
  const zonesByMember =
    options.zonesByMember instanceof Map ? options.zonesByMember : new Map();
  const tiersByOwner =
    options.tiersByOwner instanceof Map ? options.tiersByOwner : new Map();
  const viewerId = typeof options.viewerId === 'string' ? options.viewerId : null;

  const visible = [];
  const obscured = [];

  items.forEach((item) => {
    const ownerId =
      item.member_id ||
      item.owner_member_id ||
      (typeof item.memberId === 'string' ? item.memberId : null);
    if (!ownerId) {
      visible.push(item);
      return;
    }

    const zones = zonesByMember.get(ownerId);
    if (!zones || !zones.length) {
      visible.push(item);
      return;
    }

    const lat = Number(item.lat ?? item.latitude);
    const lon = Number(item.lon ?? item.longitude);

    let matchedZone = null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const viewerTier =
        ownerId === viewerId
          ? 'self'
          : tiersByOwner.get(ownerId) || 'stranger';

      for (const zone of zones) {
        if (!shouldObscure(zone, viewerTier)) continue;
        if (!isInZone(lat, lon, zone)) continue;
        matchedZone = zone;
        break;
      }
    }

    if (matchedZone) {
      const sanitized = sanitizeItemForZone(item);
      const payload = {
        ...sanitized,
        obscured_zone: {
          zone_id: matchedZone.zone_id,
          zone_label: matchedZone.zone_label,
          zone_kind: matchedZone.zone_kind,
          coarse_city: matchedZone.coarse_city,
          coarse_region: matchedZone.coarse_region,
          coarse_country: matchedZone.coarse_country,
        },
      };
      obscured.push({ item: payload, zone: matchedZone });
    } else {
      visible.push(item);
    }
  });

  return { visible, obscured };
}

function parseZoneId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || !UUID_REGEX.test(value)) return null;
  return value;
}

module.exports = {
  distanceMeters,
  isPointInPolygon,
  isInZone,
  normalizeZoneRow,
  loadZonesForMembers,
  loadViewerRelationshipTiers,
  shouldObscure,
  applyPrivacyZones,
  parseZoneId,
};
