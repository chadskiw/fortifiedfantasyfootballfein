const pool = require('../src/db/pool');
const { loadZonesForMembers } = require('./privacyZones');
const { buildPrivacyDome, maskedPointInDome } = require('./privacyDome');

function viewerTier(viewerMemberId, ownerMemberId) {
  if (!viewerMemberId) return 'stranger';
  if (viewerMemberId === ownerMemberId) return 'self';
  return 'stranger';
}

function zoneObscuresForTier(zone, tier) {
  if (tier === 'self') return zone.obscure_for_self === true;
  if (tier === 'friend') return zone.obscure_for_friends === true;
  if (tier === 'acquaint') return zone.obscure_for_acquaint === true;
  return zone.obscure_for_strangers !== false;
}

function pointInCircleZone(zone, lat, lon) {
  if (zone.shape_type !== 'circle') return false;
  if (zone.center_lat == null || zone.center_lon == null || zone.radius_m == null) return false;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat - zone.center_lat);
  const dLon = toRad(lon - zone.center_lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(zone.center_lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const dist = R * c;
  return dist <= zone.radius_m;
}

function coarseLabel(zone) {
  const parts = [zone.coarse_city, zone.coarse_region].filter(Boolean);
  const label = parts.join(', ');
  return {
    label: label || null,
    city: zone.coarse_city || null,
    region: zone.coarse_region || null,
    country: zone.coarse_country || null,
  };
}

async function applyPrivacyToSharedCaptures({
  viewerMemberId,
  ownerMemberId,
  captures,
  db = pool,
}) {
  if (!ownerMemberId || !Array.isArray(captures) || !captures.length) {
    return captures;
  }
  const zonesMap = await loadZonesForMembers([ownerMemberId], db);
  const zones = zonesMap.get(ownerMemberId) || [];
  if (!zones.length) {
    return captures;
  }
  const tier = viewerTier(viewerMemberId, ownerMemberId);
  const domes = new Map();
  for (const z of zones) {
    if (z.shape_type === 'circle' && z.center_lat != null && z.center_lon != null) {
      domes.set(
        z.zone_id,
        buildPrivacyDome({
          memberId: ownerMemberId,
          zoneId: z.zone_id,
          baseLat: z.center_lat,
          baseLon: z.center_lon,
          zoneRadiusM: z.radius_m,
        }),
      );
    }
  }
  for (const capture of captures) {
    const match = zones.find(
      (z) => zoneObscuresForTier(z, tier) && pointInCircleZone(z, capture.lat, capture.lon),
    );
    if (!match) {
      continue;
    }
    const dome = domes.get(match.zone_id);
    if (!dome) {
      continue;
    }
    capture.privacy_zone = true;
    capture.privacy_zone_id = match.zone_id || null;
    capture.privacy_dome = dome;
    capture.privacy_coarse = coarseLabel(match);
    const masked = maskedPointInDome({
      ownerMemberId,
      zoneId: match.zone_id,
      captureId: capture.capture_id || capture.id,
      dome,
    });
    capture.lat = masked.lat;
    capture.lon = masked.lon;
  }
  return captures;
}

module.exports = {
  applyPrivacyToSharedCaptures,
};
