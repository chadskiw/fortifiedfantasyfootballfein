const crypto = require('crypto');

function jitterMetersDeterministic(seedStr, maxMeters) {
  const h = crypto.createHash('sha256').update(seedStr).digest();
  const a = h.readUInt32BE(0) / 0xffffffff;
  const b = h.readUInt32BE(4) / 0xffffffff;
  const r = (0.35 + 0.65 * a) * maxMeters;
  const theta = 2 * Math.PI * b;
  return { dx: r * Math.cos(theta), dy: r * Math.sin(theta) };
}

function offsetLatLon(lat, lon, dxMeters, dyMeters) {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + dyMeters / metersPerDegLat,
    lon: lon + dxMeters / metersPerDegLon,
  };
}

function buildPrivacyDome({ memberId, zoneId, baseLat, baseLon, zoneRadiusM }) {
  const seed = `${memberId}:${zoneId}:privacy_dome_v1`;
  const { dx, dy } = jitterMetersDeterministic(seed, 900);
  const center = offsetLatLon(baseLat, baseLon, dx, dy);
  const radius_m = Math.max(1200, Math.min((zoneRadiusM || 800) * 2, 3200));
  return { center_lat: center.lat, center_lon: center.lon, radius_m };
}

function maskedPointInDome({ ownerMemberId, zoneId, captureId, dome }) {
  const seed = `${ownerMemberId}:${zoneId}:${captureId}:privacy_point_v1`;
  const { dx, dy } = jitterMetersDeterministic(seed, dome.radius_m * 0.9);
  return offsetLatLon(dome.center_lat, dome.center_lon, dx, dy);
}

module.exports = {
  jitterMetersDeterministic,
  offsetLatLon,
  buildPrivacyDome,
  maskedPointInDome,
};
