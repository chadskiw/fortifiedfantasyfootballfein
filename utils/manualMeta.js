const MANUAL_META_SOURCES = new Set([
  'user_input',
  'here_now',
  'exif',
  'photo',
  'video',
  'audio',
  'device',
  'drop',
]);

function coerceNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSource(raw) {
  if (!raw) return 'user_input';
  const value = String(raw).trim().toLowerCase();
  if (value === 'here' || value === 'hereandnow' || value === 'here_now') {
    return 'here_now';
  }
  return MANUAL_META_SOURCES.has(value) ? value : 'user_input';
}

function parseManualMeta(raw) {
  if (!raw) return null;
  const payload =
    typeof raw.manual_meta === 'object' && raw.manual_meta !== null
      ? raw.manual_meta
      : raw;

  const lat =
    coerceNumber(
      payload.manual_lat ??
        payload.lat ??
        payload.latitude ??
        payload.meta_lat ??
        payload.user_lat
    ) ?? null;
  const lon =
    coerceNumber(
      payload.manual_lon ??
        payload.lon ??
        payload.longitude ??
        payload.meta_lon ??
        payload.user_lon
    ) ?? null;
  const takenAtRaw =
    payload.manual_taken_at ??
    payload.taken_at ??
    payload.timestamp ??
    payload.meta_taken_at ??
    payload.takenAt ??
    null;

  if (lat == null || lon == null || takenAtRaw == null) {
    return null;
  }

  const takenAt = new Date(takenAtRaw);
  if (Number.isNaN(takenAt.getTime())) {
    return null;
  }

  return {
    lat,
    lon,
    takenAt,
    source: normalizeSource(
      payload.manual_meta_source ?? payload.source ?? payload.meta_source
    ),
  };
}

async function recordManualMeta(pool, entityKind, entityKey, meta, createdBy) {
  if (!pool || !entityKind || !entityKey || !meta) return;
  await pool.query(
    `
      INSERT INTO tt_media_manual_meta (
        entity_kind,
        entity_key,
        lat,
        lon,
        taken_at,
        source,
        created_by,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (entity_kind, entity_key)
      DO UPDATE
         SET lat      = EXCLUDED.lat,
             lon      = EXCLUDED.lon,
             taken_at = EXCLUDED.taken_at,
             source   = EXCLUDED.source,
             updated_at = NOW(),
             created_by = COALESCE(EXCLUDED.created_by, tt_media_manual_meta.created_by)
    `,
    [
      entityKind,
      entityKey,
      meta.lat,
      meta.lon,
      meta.takenAt,
      meta.source,
      createdBy || null,
    ]
  );
}

async function updateQuickhitterLocation(pool, memberId, coords = {}, options = {}) {
  if (!pool || !memberId || !coords) return;
  const lat = coerceNumber(
    coords.lat ??
      coords.latitude ??
      coords.manual_lat ??
      coords.meta_lat ??
      options.lat ??
      options.latitude
  );
  const lon = coerceNumber(
    coords.lon ??
      coords.longitude ??
      coords.manual_lon ??
      coords.meta_lon ??
      options.lon ??
      options.longitude
  );
  if (lat == null || lon == null) return;
  const rawSource =
    coords.source ||
    coords.meta_source ||
    coords.manual_meta_source ||
    options.source ||
    'user_input';
  const source = normalizeSource(rawSource);
  const accuracy = coerceNumber(
    coords.accuracy ??
      coords.accuracy_m ??
      coords.location_accuracy ??
      options.accuracy
  );
  const locationState =
    options.location_state ??
    coords.location_state ??
    coords.state ??
    options.state ??
    null;
  try {
    await pool.query(
      `
        UPDATE ff_quickhitter
           SET last_latitude = $2,
               last_longitude = $3,
               last_location_source = $4,
               last_location_accuracy_m = COALESCE($5, last_location_accuracy_m),
               location_state = COALESCE($6, location_state),
               last_location_updated_at = NOW(),
               updated_at = NOW()
         WHERE member_id = $1
      `,
      [memberId, lat, lon, source, accuracy, locationState]
    );
  } catch (err) {
    console.warn(
      '[manualMeta:updateQuickhitterLocation]',
      err?.message || err
    );
  }
}

module.exports = {
  parseManualMeta,
  recordManualMeta,
  updateQuickhitterLocation,
};
