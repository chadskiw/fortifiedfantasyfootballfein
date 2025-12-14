const express = require('express');
const { getCurrentIdentity } = require('../services/identity');
const pool = require('../src/db/pool');
const {
  normalizeZoneRow,
  loadZonesForMembers,
  parseZoneId,
} = require('../utils/privacyZones');
const { buildPrivacyDome, maskedPointInDome } = require('../utils/privacyDome');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

const ALLOWED_KINDS = new Set([
  'home',
  'school',
  'work',
  'business',
  'event',
  'custom',
  'other',
]);
const ALLOWED_SHAPES = new Set(['circle', 'polygon']);


function normalizeText(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const str = String(value).trim().toLowerCase();
  if (!str) return fallback;
  return str === 'true' || str === '1' || str === 'yes' || str === 'on';
}

function normalizeLat(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < -90 || num > 90) return null;
  return num;
}

function normalizeLon(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < -180 || num > 180) return null;
  return num;
}

function clampRadius(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(25, Math.min(num, 5000));
  return clamped;
}

function normalizePolygon(raw) {
  if (!Array.isArray(raw)) return null;
  const coords = raw
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const lat = normalizeLat(point[0]);
      const lon = normalizeLon(point[1]);
      if (lat == null || lon == null) return null;
      return [lat, lon];
    })
    .filter(Boolean);
  return coords.length >= 3 ? coords : null;
}

function normalizeKind(value, fallback = 'custom') {
  const text = normalizeText(value);
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  return ALLOWED_KINDS.has(normalized) ? normalized : fallback;
}

function normalizeShape(value, fallback = null) {
  const text = normalizeText(value);
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  return ALLOWED_SHAPES.has(normalized) ? normalized : fallback;
}

function normalizeCoarse(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return text.slice(0, 120);
}

function normalizeZonePayload(source = {}, { existing = null } = {}) {
  const errors = [];
  const payload = {};

  const current = existing ? { ...existing } : {};

  const zoneLabel =
    normalizeText(source.zone_label ?? source.zoneLabel) ??
    current.zone_label ??
    null;
  if (!zoneLabel) {
    errors.push('zone_label_required');
  } else {
    payload.zone_label = zoneLabel;
  }

  payload.zone_kind = normalizeKind(
    source.zone_kind ?? source.zoneKind ?? current.zone_kind ?? 'custom'
  );

  const requestedShape =
    normalizeShape(source.shape_type ?? source.shapeType) ??
    current.shape_type ??
    null;
  if (!requestedShape) {
    errors.push('shape_type_required');
  } else {
    payload.shape_type = requestedShape;
  }

  if (payload.shape_type === 'circle') {
    const lat =
      normalizeLat(source.center_lat ?? source.centerLat) ??
      current.center_lat ??
      null;
    const lon =
      normalizeLon(source.center_lon ?? source.centerLon) ??
      current.center_lon ??
      null;
    const radius =
      clampRadius(source.radius_m ?? source.radiusM) ??
      current.radius_m ??
      null;

    if (lat == null || lon == null || radius == null) {
      errors.push('circle_requires_center_and_radius');
    }

    payload.center_lat = lat;
    payload.center_lon = lon;
    payload.radius_m = radius;
    payload.polygon = null;
  } else if (payload.shape_type === 'polygon') {
    const polygon =
      normalizePolygon(source.polygon) ??
      current.polygon ??
      null;
    if (!polygon) {
      errors.push('polygon_requires_points');
    }
    payload.polygon = polygon;
    payload.center_lat = null;
    payload.center_lon = null;
    payload.radius_m = null;
  }

  payload.obscure_for_strangers = normalizeBool(
    source.obscure_for_strangers ?? source.obscureForStrangers,
    current.obscure_for_strangers !== false
  );
  payload.obscure_for_acquaint = normalizeBool(
    source.obscure_for_acquaint ?? source.obscureForAcquaint,
    current.obscure_for_acquaint === true
  );
  payload.obscure_for_friends = normalizeBool(
    source.obscure_for_friends ?? source.obscureForFriends,
    current.obscure_for_friends === true
  );
  payload.obscure_for_self = normalizeBool(
    source.obscure_for_self ?? source.obscureForSelf,
    current.obscure_for_self === true
  );

  payload.coarse_city =
    normalizeCoarse(source.coarse_city ?? source.coarseCity) ??
    current.coarse_city ??
    null;
  payload.coarse_region =
    normalizeCoarse(source.coarse_region ?? source.coarseRegion) ??
    current.coarse_region ??
    null;
  payload.coarse_country =
    normalizeCoarse(source.coarse_country ?? source.coarseCountry) ??
    current.coarse_country ??
    null;

  return { payload, errors };
}

async function requireMember(req, res, next) {
  try {
    const identity = await getCurrentIdentity(req, pool);
    const memberId = identity?.memberId || identity?.member_id || null;
    if (!memberId) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    req.viewerMemberId = memberId;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/', requireMember, async (req, res) => {
  try {
    const zonesMap = await loadZonesForMembers([req.viewerMemberId], pool);
    const zones = zonesMap.get(req.viewerMemberId) || [];
    return res.json({ ok: true, zones });
  } catch (err) {
    console.error('privacyZones.list failed', err);
    return res.status(500).json({ error: 'privacy_zones_fetch_failed' });
  }
});

router.post('/', requireMember, async (req, res) => {
  try {
    const { payload, errors } = normalizeZonePayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors[0] });
    }

    const params = [
      req.viewerMemberId,
      payload.zone_label,
      payload.zone_kind,
      payload.shape_type,
      payload.center_lat,
      payload.center_lon,
      payload.radius_m,
      payload.polygon ? JSON.stringify(payload.polygon) : null,
      payload.obscure_for_strangers,
      payload.obscure_for_acquaint,
      payload.obscure_for_friends,
      payload.obscure_for_self,
      payload.coarse_city,
      payload.coarse_region,
      payload.coarse_country,
    ];

    const { rows } = await pool.query(
      `
        INSERT INTO tt_member_privacy_zone (
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
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
        RETURNING *
      `,
      params
    );

    const zone = normalizeZoneRow(rows[0]);
    return res.status(201).json({ ok: true, zone });
  } catch (err) {
    console.error('privacyZones.create failed', err);
    return res.status(500).json({ error: 'privacy_zone_create_failed' });
  }
});

router.put('/:zoneId', requireMember, async (req, res) => {
  const zoneId = parseZoneId(req.params.zoneId);
  if (!zoneId) {
    return res.status(400).json({ error: 'invalid_zone_id' });
  }

  try {
    const { rows: existingRows } = await pool.query(
      `
        SELECT *
        FROM tt_member_privacy_zone
        WHERE zone_id = $1
          AND member_id = $2
        LIMIT 1
      `,
      [zoneId, req.viewerMemberId]
    );

    if (!existingRows.length) {
      return res.status(404).json({ error: 'privacy_zone_not_found' });
    }

    const existing = normalizeZoneRow(existingRows[0]);
    const { payload, errors } = normalizeZonePayload(req.body || {}, { existing });
    if (errors.length) {
      return res.status(400).json({ error: errors[0] });
    }

    const params = [
      zoneId,
      req.viewerMemberId,
      payload.zone_label,
      payload.zone_kind,
      payload.shape_type,
      payload.center_lat,
      payload.center_lon,
      payload.radius_m,
      payload.polygon ? JSON.stringify(payload.polygon) : null,
      payload.obscure_for_strangers,
      payload.obscure_for_acquaint,
      payload.obscure_for_friends,
      payload.obscure_for_self,
      payload.coarse_city,
      payload.coarse_region,
      payload.coarse_country,
    ];

    const { rows } = await pool.query(
      `
        UPDATE tt_member_privacy_zone
           SET zone_label = $3,
               zone_kind = $4,
               shape_type = $5,
               center_lat = $6,
               center_lon = $7,
               radius_m = $8,
               polygon = $9::jsonb,
               obscure_for_strangers = $10,
               obscure_for_acquaint = $11,
               obscure_for_friends = $12,
               obscure_for_self = $13,
               coarse_city = $14,
               coarse_region = $15,
               coarse_country = $16,
               updated_at = NOW()
         WHERE zone_id = $1
           AND member_id = $2
        RETURNING *
      `,
      params
    );

    const zone = normalizeZoneRow(rows[0]);
    return res.json({ ok: true, zone });
  } catch (err) {
    console.error('privacyZones.update failed', err);
    return res.status(500).json({ error: 'privacy_zone_update_failed' });
  }
});

router.delete('/:zoneId', requireMember, async (req, res) => {
  const zoneId = parseZoneId(req.params.zoneId);
  if (!zoneId) {
    return res.status(400).json({ error: 'invalid_zone_id' });
  }

  try {
    const { rowCount } = await pool.query(
      `
        DELETE FROM tt_member_privacy_zone
        WHERE zone_id = $1
          AND member_id = $2
      `,
      [zoneId, req.viewerMemberId]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'privacy_zone_not_found' });
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('privacyZones.delete failed', err);
    return res.status(500).json({ error: 'privacy_zone_delete_failed' });
  }
});

module.exports = router;
