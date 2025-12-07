const MANUAL_META_SOURCES = new Set(['user_input', 'here_now']);

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

module.exports = {
  parseManualMeta,
  recordManualMeta,
};
