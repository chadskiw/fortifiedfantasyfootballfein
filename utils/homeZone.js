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

function isInHomeZone(photoLat, photoLon, zone) {
  if (!zone || zone.obscure_home !== true) return false;
  if (!Number.isFinite(zone.center_lat) || !Number.isFinite(zone.center_lon)) return false;
  const radius = Number(zone.radius_m) || 0;
  if (radius <= 0) return false;
  const dist = distanceMeters(photoLat, photoLon, zone.center_lat, zone.center_lon);
  return dist <= radius;
}

module.exports = {
  distanceMeters,
  isInHomeZone,
};
