// routes/trashtalk.js
const express = require('express');
const multer = require('multer');
const exifr = require('exifr'); // make sure this is installed: npm i exifr
const { uploadToR2, headR2, deleteFromR2 } = require('../services/r2Client');
const { getCurrentIdentity } = require('../services/identity');
const {
  appendVisibilityFilter,
  normalizeAudienceMode,
  normalizeRelationshipTiers,
  normalizeAllowedMembers,
  normalizeDate,
  formatPolicyRow,
  formatPhotoSetRow,
  formatVisibilityRow,
  DEFAULT_RELATIONSHIP_TIERS,
} = require('../services/photoVisibility');

const { pool } = require('../src/db/pool');
const {
  loadZonesForMembers,
  loadViewerRelationshipTiers,
  applyPrivacyZones,
} = require('../utils/privacyZones');
const { parseManualMeta, recordManualMeta } = require('../utils/manualMeta');

// ...
const router = express.Router();
const jsonParser = express.json({ limit: '256kb' });

const EARTH_RADIUS_M = 6371000; // meters
const VALID_AUDIENCES = new Set(['private', 'public', 'party']);
const DEFAULT_AUDIENCE = 'private';

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
    return null;
  }

  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

/**
 * Helper: normalize EXIF GPS to decimal lat/lon if possible.
 * exifr typically gives latitude/longitude as decimal numbers already.
 */
function extractLatLon(exifData) {
  if (!exifData) return { lat: null, lon: null };

  let lat = null;
  let lon = null;

  // Preferred: exifr's normalized values
  if (typeof exifData.latitude === 'number') lat = exifData.latitude;
  if (typeof exifData.longitude === 'number') lon = exifData.longitude;

  // Fallbacks if needed – keep light, we can expand later if EXIF is weird
  if (lat == null && typeof exifData.lat === 'number') lat = exifData.lat;
  if (lon == null && typeof exifData.lon === 'number') lon = exifData.lon;

  return { lat, lon };
}
function getImageTimestamp(exifData) {
  if (!exifData) return Date.now();

  // exifr usually gives these as Date objects if it can parse them
  const candidates = [
    exifData.CreateDate,
    exifData.DateTimeOriginal,
    exifData.DateCreated,
    exifData.ModifyDate,
  ];

  for (const c of candidates) {
    if (!c) continue;

    // If it's already a Date object
    if (c instanceof Date) {
      const t = c.getTime();
      if (!Number.isNaN(t)) return t;
    }

    // If it's a string like "2025:11:29 14:32:10"
    if (typeof c === 'string') {
      const d = new Date(c.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
      const t = d.getTime();
      if (!Number.isNaN(t)) return t;
    }
  }

  // Fallback if nothing usable
  return Date.now();
}
function getCameraFingerprint(exifData) {
  if (!exifData) return null;

  const parts = [
    exifData.Make,
    exifData.Model,
    exifData.LensModel,
  ]
    .filter(Boolean)
    .join('|')
    .trim();

  return parts || null;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePhotoIds(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((val) => {
          if (val == null) return null;
          const str = String(val).trim();
          if (!str) return null;
          return UUID_PATTERN.test(str) ? str : null;
        })
        .filter(Boolean)
    )
  );
}
/**
 * Haversine distance calculation in SQL:
 * We'll inline the math in the query. This function just returns the snippet.
 */
function haversineSql(latParam, lonParam, latCol = 'lat', lonCol = 'lon') {
  // latParam / lonParam will be bind params like $1, $2
  return `
    ${EARTH_RADIUS_M} * acos(
      cos(radians(${latParam})) * cos(radians(${latCol})) *
      cos(radians(${lonCol}) - radians(${lonParam})) +
      sin(radians(${latParam})) * sin(radians(${latCol}))
    )
  `;
}

function collectOwnerIds(rows = []) {
  return Array.from(
    new Set(
      rows
        .map((row) => {
          if (!row) return '';
          if (typeof row.member_id === 'string') return row.member_id;
          if (typeof row.owner_member_id === 'string') return row.owner_member_id;
          if (typeof row.memberId === 'string') return row.memberId;
          return '';
        })
        .filter((id) => id && id.trim().length)
    )
  );
}

async function buildPrivacyContext(ownerIds = [], viewerId) {
  if (!ownerIds.length) {
    return {
      zonesByMember: new Map(),
      tiersByOwner: new Map(),
    };
  }

  let zonesByMember = new Map();
  let tiersByOwner = new Map();
  try {
    zonesByMember = await loadZonesForMembers(ownerIds, pool);
  } catch (err) {
    console.warn('privacyZones.load failed', err?.message || err);
  }
  try {
    tiersByOwner = await loadViewerRelationshipTiers(viewerId, ownerIds, pool);
  } catch (err) {
    console.warn('privacyZones.viewerTiers failed', err?.message || err);
  }

  return { zonesByMember, tiersByOwner };
}

function rebuildRowsWithPrivacy(rows, visible, obscured) {
  const byId = new Map();
  visible.forEach((row) => {
    if (row && row.photo_id) {
      byId.set(String(row.photo_id), row);
    }
  });
  obscured.forEach(({ item }) => {
    if (item && item.photo_id) {
      byId.set(String(item.photo_id), item);
    }
  });
  return rows.map((row) => {
    if (!row || !row.photo_id) return row;
    return byId.get(String(row.photo_id)) || row;
  });
}

async function ensurePartyUploadAccess(partyId, handle) {
  if (!partyId) return { ok: true };

  const { rows: partyRows } = await pool.query(
    'SELECT party_id, state, host_handle FROM tt_party WHERE party_id = $1 LIMIT 1',
    [partyId]
  );
  if (!partyRows.length) {
    return { ok: false, status: 404, error: 'party_not_found' };
  }
  const partyRow = partyRows[0];
  if (partyRow.state === 'cut') {
    return { ok: false, status: 410, error: 'party_cut' };
  }

  const hostHandle = (partyRow.host_handle || '').toLowerCase();
  const requester = (handle || '').toLowerCase();
  if (hostHandle && requester && hostHandle === requester) {
    return {
      ok: true,
      party: partyRow,
      membership: { access_level: 'host' },
    };
  }

  const { rows: membershipRows } = await pool.query(
    `
      SELECT access_level
        FROM tt_party_member
       WHERE party_id = $1
         AND handle = $2
       LIMIT 1
    `,
    [partyId, handle]
  );

  if (
    !membershipRows.length ||
    membershipRows[0].access_level !== 'live'
  ) {
    return { ok: false, status: 403, error: 'live_access_required' };
  }

  return {
    ok: true,
    party: partyRows[0],
    membership: membershipRows[0],
  };
}

async function getViewerContext(req, { requireAuth = false } = {}) {
  try {
    const identity = await getCurrentIdentity(req, pool);
    const viewerId = identity?.memberId || identity?.member_id || null;
    if (requireAuth && !viewerId) {
      const err = new Error('not_authenticated');
      err.statusCode = 401;
      throw err;
    }

    return {
      identity,
      viewerId,
      handle: identity?.handle || null,
    };
  } catch (err) {
    if (requireAuth) {
      throw err;
    }
    return {
      identity: null,
      viewerId: null,
      handle: null,
    };
  }
}

function resolveAudience(requested, hasParty) {
  if (hasParty) return 'party';
  if (!requested) return DEFAULT_AUDIENCE;
  const normalized = String(requested).toLowerCase();
  if (normalized === 'party') return hasParty ? 'party' : DEFAULT_AUDIENCE;
  if (VALID_AUDIENCES.has(normalized)) return normalized;
  return DEFAULT_AUDIENCE;
}

async function findNearbyPartyForHandle(handle, lat, lon) {
  if (
    !handle ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }

  const { rows } = await pool.query(
    `
      SELECT
        p.party_id,
        p.host_handle,
        p.center_lat,
        p.center_lon,
        p.radius_m,
        p.state,
        pm.access_level
      FROM tt_party p
      LEFT JOIN tt_party_member pm
        ON pm.party_id = p.party_id
       AND pm.handle = $1
      WHERE
        p.state <> 'cut'
        AND p.center_lat IS NOT NULL
        AND p.center_lon IS NOT NULL
        AND p.radius_m IS NOT NULL
        AND (
          p.host_handle = $1
          OR pm.handle = $1
        )
    `,
    [handle]
  );

  let best = null;
  for (const row of rows) {
    const radius = Number(row.radius_m) || 0;
    const dist = distanceMeters(
      Number(row.center_lat),
      Number(row.center_lon),
      lat,
      lon
    );
    if (dist == null) continue;

    const allowed = radius ? radius * 1.3 : 150;
    if (dist > allowed) continue;

    const hostMatch =
      (row.host_handle || '').toLowerCase() === handle.toLowerCase();
    const invited =
      hostMatch ||
      (row.access_level &&
        row.access_level !== 'declined');
    if (!invited) continue;

    if (!best || dist < best.dist) {
      best = { party_id: row.party_id, dist };
    }
  }

  return best?.party_id || null;
}

async function fetchPartyBasics(partyId) {
  if (!partyId) return null;
  const { rows } = await pool.query(
    `
      SELECT
        party_id,
        host_member_id,
        host_handle,
        state,
        starts_at,
        ends_at
      FROM tt_party
      WHERE party_id = $1
      LIMIT 1
    `,
    [partyId]
  );
  return rows[0] || null;
}

async function fetchPartyMembership(partyId, handle) {
  if (!partyId || !handle) return null;
  const { rows } = await pool.query(
    `
      SELECT *
        FROM tt_party_member
       WHERE party_id = $1
         AND handle = $2
       LIMIT 1
    `,
    [partyId, handle]
  );
  return rows[0] || null;
}

async function requirePartyAccess(req, res, next) {
  try {
    const me = await getCurrentIdentity(req, pool);
    if (!me) {
      return res.status(401).json({ error: 'not_logged_in' });
    }
    const { partyId } = req.params;
    if (!partyId) {
      return res.status(400).json({ error: 'party_id_required' });
    }
    const party = await fetchPartyBasics(partyId);
    if (!party) {
      return res.status(404).json({ error: 'party_not_found' });
    }
    if ((party.state || '').toLowerCase() === 'cut') {
      return res.status(410).json({ error: 'party_cut' });
    }

    const hostHandle = (party.host_handle || '').toLowerCase();
    const myHandle = (me.handle || '').toLowerCase();
    const isHost = hostHandle && myHandle && hostHandle === myHandle;

    let membership = null;
    if (!isHost) {
      membership = await fetchPartyMembership(partyId, me.handle);
      if (!membership) {
        return res.status(403).json({ error: 'not_invited' });
      }
      const accessLevel = (membership.access_level || '').toLowerCase();
      if (accessLevel === 'declined') {
        return res.status(403).json({ error: 'party_declined' });
      }
      if (accessLevel === 'card') {
        return res.status(403).json({ error: 'not_checked_in' });
      }
    } else {
      membership = {
        party_id: party.party_id,
        member_id: me.memberId || me.member_id || null,
        handle: me.handle,
        access_level: 'host',
      };
    }

    req.me = me;
    req.party = party;
    req.membership = membership;
    req.member = {
      member_id: membership?.member_id || me.memberId || me.member_id || null,
      handle: me.handle,
      access_level: membership?.access_level || (isHost ? 'host' : 'guest'),
    };
    req.isPartyHost = isHost;
    next();
  } catch (err) {
    next(err);
  }
}

async function fetchMemberPolicy(memberId) {
  if (!memberId) return formatPolicyRow(null);
  const { rows } = await pool.query(
    `
      SELECT
        member_id,
        default_audience_mode,
        default_relationship_tiers,
        default_party_scope,
        auto_share_current_party,
        created_at,
        updated_at
      FROM tt_member_photo_policy
      WHERE member_id = $1
      LIMIT 1
    `,
    [memberId]
  );
  const formatted = rows.length ? formatPolicyRow(rows[0]) : formatPolicyRow({ member_id: memberId });
  formatted.member_id = memberId;
  return formatted;
}

async function fetchPhotoSets(memberId) {
  if (!memberId) return [];
  const { rows } = await pool.query(
    `
      SELECT
        ps.*,
        COUNT(psi.photo_id)::int AS photo_count
      FROM tt_photo_set ps
      LEFT JOIN tt_photo_set_item psi
        ON psi.photo_set_id = ps.photo_set_id
      WHERE ps.member_id = $1
      GROUP BY ps.photo_set_id
      ORDER BY ps.updated_at DESC NULLS LAST, ps.photo_set_id DESC
    `,
    [memberId]
  );
  return rows.map(formatPhotoSetRow).filter(Boolean);
}

async function fetchVisibilitySummary(memberId) {
  if (!memberId) {
    return {
      total_photos: 0,
      overridden_photos: 0,
      public_photos: 0,
      relationship_photos: 0,
      party_photos: 0,
      custom_photos: 0,
    };
  }

  const { rows } = await pool.query(
    `
      SELECT
        COUNT(*)::int AS total_photos,
        COUNT(*) FILTER (WHERE pv.photo_id IS NOT NULL)::int AS overridden_photos,
        COUNT(*) FILTER (WHERE vis.audience_mode = 'public')::int AS public_photos,
        COUNT(*) FILTER (WHERE vis.audience_mode = 'relationships')::int AS relationship_photos,
        COUNT(*) FILTER (WHERE vis.audience_mode = 'party')::int AS party_photos,
        COUNT(*) FILTER (WHERE vis.audience_mode = 'custom_list')::int AS custom_photos
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      LEFT JOIN tt_photo_visibility pv
        ON pv.photo_id = p.photo_id
      WHERE p.member_id = $1
    `,
    [memberId]
  );

  return rows[0] || {
    total_photos: 0,
    overridden_photos: 0,
    public_photos: 0,
    relationship_photos: 0,
    party_photos: 0,
    custom_photos: 0,
  };
}

async function fetchMemberPhotosWithVisibility({ memberId, viewerId, limit = 100, offset = 0 }) {
  const safeLimit = clampNumber(limit, 1, 500, 100);
  const safeOffset = clampNumber(offset, 0, 5000, 0);
  const params = [memberId];
  const visibilityClause = appendVisibilityFilter({ viewerId, alias: 'vis', params });

  params.push(safeLimit);
  const limitParam = `$${params.length}`;
  params.push(safeOffset);
  const offsetParam = `$${params.length}`;

  const sql = `
    SELECT
      p.photo_id,
      p.member_id,
      p.handle,
      p.r2_key,
      p.original_filename,
      p.mime_type,
      p.lat,
      p.lon,
      p.taken_at,
      p.created_at,
      vis.audience_mode,
      vis.relationship_tiers,
      vis.party_id,
      vis.allowed_member_ids,
      vis.expires_at,
      vis.policy_updated_at,
      (pv.photo_id IS NOT NULL) AS has_override,
      COALESCE(set_members.set_ids, ARRAY[]::bigint[]) AS set_ids,
      COUNT(*) OVER()::int AS total_count
    FROM tt_photo p
    JOIN vw_photo_effective_visibility vis
      ON vis.photo_id = p.photo_id
    LEFT JOIN tt_photo_visibility pv
      ON pv.photo_id = p.photo_id
    LEFT JOIN LATERAL (
      SELECT array_agg(photo_set_id) AS set_ids
      FROM tt_photo_set_item
      WHERE photo_id = p.photo_id
    ) set_members ON TRUE
    WHERE p.member_id = $1
      AND ${visibilityClause}
    ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam};
  `;

  const { rows } = await pool.query(sql, params);
  const total = rows.length ? rows[0].total_count : 0;
  const photos = rows.map((row) => ({
    photo_id: row.photo_id,
    member_id: row.member_id,
    handle: row.handle,
    r2_key: row.r2_key,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    lat: row.lat,
    lon: row.lon,
    taken_at: row.taken_at,
    created_at: row.created_at,
    visibility: formatVisibilityRow(row),
    has_override: row.has_override === true,
    set_ids: Array.isArray(row.set_ids) ? row.set_ids : [],
  }));

  let sanitizedPhotos = photos;
  if (photos.length) {
    const ownerIds = collectOwnerIds(photos);
    const { zonesByMember, tiersByOwner } = await buildPrivacyContext(
      ownerIds,
      viewerId
    );
    const { visible, obscured } = applyPrivacyZones(photos, {
      viewerId,
      zonesByMember,
      tiersByOwner,
    });
    sanitizedPhotos = rebuildRowsWithPrivacy(photos, visible, obscured);
  }

  return { photos: sanitizedPhotos, total, limit: safeLimit, offset: safeOffset };
}

async function ensurePhotosOwnedBy(memberId, photoIds) {
  if (!memberId || !photoIds.length) return [];
  const { rows } = await pool.query(
    `
      SELECT photo_id
      FROM tt_photo
      WHERE member_id = $1
        AND photo_id = ANY($2::uuid[])
    `,
    [memberId, photoIds]
  );

  const ownedSet = new Set(rows.map((row) => String(row.photo_id)));
  const missing = photoIds.filter((id) => !ownedSet.has(String(id)));
  if (missing.length) {
    const err = new Error('photo_not_owned');
    err.statusCode = 403;
    err.meta = { missing };
    throw err;
  }

  return Array.from(ownedSet);
}

/**
 * POST /api/trashtalk/upload
 * Upload photos, parse EXIF, stash in R2 + tt_photo.
 */
let cameraFingerprint = null;
router.post(
  '/upload',
  upload.array('photos', 100),
  async (req, res) => {
    try {
      const me = await getCurrentIdentity(req, pool);
      if (!me || !me.handle) {
        return res.status(401).json({ error: 'handle_required' });
      }
      const ownerHandle = me.handle;
      const ownerMemberId = me.memberId || me.member_id || null;

      const rawParty = req.body?.partyId ?? req.body?.party_id ?? null;
      const partyId =
        rawParty && String(rawParty).trim() ? String(rawParty).trim() : null;
      const requestedAudience = req.body?.audience;

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      if (partyId) {
        const access = await ensurePartyUploadAccess(partyId, ownerHandle);
        if (!access.ok) {
          return res
            .status(access.status || 400)
            .json({ error: access.error || 'party_upload_not_allowed' });
        }
      }


      const manualMeta = parseManualMeta(req.body);
      const results = [];

      for (const file of req.files) {
        if (!file.mimetype.startsWith('image/')) continue;

        let exifData = null;
        let lat = null;
        let lon = null;
        let usedManualMeta = false;

        try {
        exifData = await exifr.parse(file.buffer);
        const coords = extractLatLon(exifData);
        lat = coords.lat;
        lon = coords.lon;
        cameraFingerprint = getCameraFingerprint(exifData);
        } catch (err) {
        console.warn('EXIF parse failed for', file.originalname, err.message);
        }

                const timestamp = getImageTimestamp(exifData); // ← from metadata when possible
        let takenAt = new Date(timestamp);
        if ((lat == null || lon == null) && manualMeta) {
        lat = manualMeta.lat;
        lon = manualMeta.lon;
        usedManualMeta = true;
        }
        if ((!takenAt || Number.isNaN(takenAt.getTime())) && manualMeta?.takenAt) {
        takenAt = manualMeta.takenAt;
        usedManualMeta = true;
        }
        if (!takenAt || Number.isNaN(takenAt.getTime())) {
        takenAt = new Date(timestamp);
        }
        const locationSource = usedManualMeta
          ? manualMeta?.source || 'user_input'
          : Number.isFinite(lat) && Number.isFinite(lon)
            ? 'exif'
            : null;
        const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
        const r2Key = `trashtalk/${ownerHandle}/${timestamp}_${safeName}`;


        await uploadToR2({
          key: r2Key,
          body: file.buffer,
          contentType: file.mimetype,
        });

let exifPayload = exifData ? { ...exifData } : null;
if (usedManualMeta && manualMeta) {
if (!exifPayload) exifPayload = {};
exifPayload.user_input = {
lat: manualMeta.lat,
lon: manualMeta.lon,
taken_at: manualMeta.takenAt ? manualMeta.takenAt.toISOString() : null,
source: manualMeta.source,
};
}
const exifJson = exifPayload ? JSON.stringify(exifPayload) : null;
        let effectivePartyId = partyId;
        if (!effectivePartyId) {
          effectivePartyId = await findNearbyPartyForHandle(
            ownerHandle,
            lat,
            lon
          );
        }

        const audience = resolveAudience(
          requestedAudience,
          Boolean(effectivePartyId)
        );

                const upsertValues = [
                  ownerHandle,           // 
                  r2Key,                 // 
                  ownerMemberId,         // 
                  file.originalname,     // 
                  file.mimetype,         // 
                  exifJson,              // 
                  lat,                   // 
                  lon,                   // 
                  takenAt,               // 
                  cameraFingerprint,     // 
                  effectivePartyId,      // 
                  audience,              // 
                  locationSource         // 
                ];

        const existing = await pool.query(
          `
            SELECT photo_id
              FROM tt_photo
             WHERE handle = $1
               AND r2_key = $2
             LIMIT 1;
          `,
          [ownerHandle, r2Key]
        );

        let row;
        if (existing.rows.length) {
          const updateQuery = `
            UPDATE tt_photo AS t
               SET member_id          = COALESCE(t.member_id, $3),
                   original_filename  = COALESCE(t.original_filename, $4),
                   mime_type          = COALESCE($5, t.mime_type),
                   exif               = COALESCE($6, t.exif),
                   lat                = COALESCE($7, t.lat),
                   lon                = COALESCE($8, t.lon),
                   taken_at           = COALESCE(t.taken_at, $9),
                   camera_fingerprint = COALESCE(t.camera_fingerprint, $10),
                   party_id           = COALESCE($11, t.party_id),
                   audience           = COALESCE($12, t.audience),
                   location_source    = COALESCE($13, t.location_source)
             WHERE t.photo_id = $14
               AND t.handle = $1
               AND t.r2_key = $2
             RETURNING photo_id,
                      handle,
                      r2_key,
                      created_at,
                      lat,
                      lon,
                      taken_at,
                      camera_fingerprint,
                      party_id,
                      audience;
          `;

          const updateValues = [...upsertValues, existing.rows[0].photo_id];
          const { rows } = await pool.query(updateQuery, updateValues);
          row = rows[0];
        } else {
          const insertQuery = `
            INSERT INTO tt_photo (
              handle,
              r2_key,
              member_id,
              original_filename,
              mime_type,
              exif,
              lat,
              lon,
              taken_at,
              camera_fingerprint,
              party_id,
              audience,
              location_source
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING photo_id,
                      handle,
                      r2_key,
                      created_at,
                      lat,
                      lon,
                      taken_at,
                      camera_fingerprint,
                      party_id,
                      audience;
          `;

          const { rows } = await pool.query(insertQuery, upsertValues);
          row = rows[0];
        }

        if (row && usedManualMeta) {
          await recordManualMeta(
            pool,
            'photo',
            String(row.photo_id),
            manualMeta,
            ownerMemberId || ownerHandle
          );
        }

        if (row) {
          results.push(row);
        }
      }

      return res.status(201).json({
        uploaded: results.length,
        photos: results,
      });
    } catch (err) {
      console.error('TrashTalk upload error', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/trashtalk/nearby?lat=..&lon=..&radiusMeters=..
 *
 * Returns photos whose GPS is within radiusMeters of the provided point,
 * newest first.
 */
router.get('/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radiusMeters = parseFloat(req.query.radiusMeters) || 150; // default 150m

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon query params required' });
    }

    const { viewerId } = await getViewerContext(req).catch(() => ({ viewerId: null }));
    const distanceExpr = haversineSql('$1', '$2');
    const params = [lat, lon, radiusMeters];
    const visibilityClause = appendVisibilityFilter({ viewerId, alias: 'vis', params });

    const sql = `
      SELECT
        p.photo_id,
        p.member_id,
        p.handle,
        p.r2_key,
        p.original_filename,
        p.mime_type,
        p.created_at,
        p.taken_at,
        p.lat,
        p.lon,
        ${distanceExpr} AS distance_m,
        vis.audience_mode,
        vis.relationship_tiers,
        vis.party_id
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      WHERE
        p.lat IS NOT NULL
        AND p.lon IS NOT NULL
        AND ${distanceExpr} <= $3
        AND ${visibilityClause}
      ORDER BY distance_m, p.taken_at DESC NULLS LAST, p.created_at DESC
      LIMIT 200;
    `;

    const queryResult = await pool.query(sql, params);
    const rows = Array.isArray(queryResult?.rows) ? queryResult.rows : [];

    return res.json({
      lat,
      lon,
      radiusMeters,
      total: rows.length,
      photos: rows,
    });
  } catch (err) {
    console.error('TrashTalk nearby error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/businesses', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    let radiusMeters = parseFloat(req.query.radiusMeters);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon query params required' });
    }

    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      radiusMeters = 5000;
    }
    radiusMeters = Math.min(Math.max(radiusMeters, 250), 20000);

    const distanceExpr = haversineSql('$1', '$2', 'center_lat', 'center_lon');

    const { rows } = await pool.query(
      `
        SELECT
          party_id,
          name,
          host_handle,
          center_lat,
          center_lon,
          radius_m,
          starts_at,
          ends_at,
          state,
          ${distanceExpr} AS distance_m
        FROM tt_party
        WHERE party_type = 'business'
          AND state <> 'cut'
          AND center_lat IS NOT NULL
          AND center_lon IS NOT NULL
          AND ${distanceExpr} <= $3
        ORDER BY distance_m ASC
        LIMIT 200
      `,
      [lat, lon, radiusMeters]
    );

    return res.json({
      lat,
      lon,
      radiusMeters,
      parties: rows,
    });
  } catch (err) {
    console.error('TrashTalk businesses error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/debug/latest-object', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r2_key
         FROM tt_photo
        WHERE r2_key IS NOT NULL
        ORDER BY taken_at DESC
        LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No photos in DB yet' });
    }

    const key = rows[0].r2_key;

    try {
      const head = await headR2({ key });
      return res.json({
        ok: true,
        key,
        existsInR2: true,
        contentLength: head.ContentLength,
        contentType: head.ContentType,
      });
    } catch (err) {
      console.error('[TrashTalk] headR2 error', err);
      return res.status(500).json({
        ok: false,
        key,
        existsInR2: false,
        message: err.message,
      });
    }
  } catch (err) {
    console.error('[TrashTalk] debug latest-object error', err);
    return res.status(500).json({ error: 'debug failed' });
  }
});
// GET /api/trashtalk/map?minLat=&maxLat=&minLon=&maxLon=&zoom=
router.get('/map', async (req, res) => {
  try {
    const minLat = parseFloat(req.query.minLat);
    const maxLat = parseFloat(req.query.maxLat);
    const minLon = parseFloat(req.query.minLon);
    const maxLon = parseFloat(req.query.maxLon);
    const zoom = parseInt(req.query.zoom, 10) || 4;

    if (
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLat) ||
      !Number.isFinite(minLon) ||
      !Number.isFinite(maxLon)
    ) {
      return res.status(400).json({ error: 'minLat, maxLat, minLon, maxLon required' });
    }

    // Simple safety clamp: don’t blow up at world scale
    const MAX_RETURN = zoom <= 3 ? 300 : zoom <= 6 ? 800 : 2000;

    const { viewerId } = await getViewerContext(req).catch(() => ({ viewerId: null }));
    const params = [minLat, maxLat, minLon, maxLon, MAX_RETURN];
    const visibilityClause = appendVisibilityFilter({ viewerId, alias: 'vis', params });

    const sql = `
      SELECT
        p.photo_id,
        p.member_id,
        p.handle,
        p.r2_key,
        p.original_filename,
        p.mime_type,
        p.lat,
        p.lon,
        p.taken_at,
        p.created_at,
        vis.audience_mode,
        vis.relationship_tiers,
        vis.party_id
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      WHERE
        p.lat IS NOT NULL
        AND p.lon IS NOT NULL
        AND p.lat BETWEEN $1 AND $2
        AND p.lon BETWEEN $3 AND $4
        AND ${visibilityClause}
      ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC
      LIMIT $5;
    `;

    const { rows } = await pool.query(sql, params);

    const ownerIds = collectOwnerIds(rows);
    const { zonesByMember, tiersByOwner } = await buildPrivacyContext(
      ownerIds,
      viewerId
    );
    const { visible, obscured } = applyPrivacyZones(rows, {
      viewerId,
      zonesByMember,
      tiersByOwner,
    });

    const homePhotos = [];
    const zonePhotos = [];
    obscured.forEach(({ item, zone }) => {
      const payload = {
        photo_id: item.photo_id,
        member_id: item.member_id,
        handle: item.handle,
        r2_key: item.r2_key,
        taken_at: item.taken_at,
        created_at: item.created_at,
        zone_id: zone.zone_id,
        zone_label: zone.zone_label,
        zone_kind: zone.zone_kind,
        coarse_city: zone.coarse_city,
        coarse_region: zone.coarse_region,
        coarse_country: zone.coarse_country,
      };
      if (zone.zone_kind === 'home') {
        payload.home_label_city = zone.coarse_city || null;
        payload.home_label_region = zone.coarse_region || null;
        payload.home_label_country = zone.coarse_country || null;
        homePhotos.push(payload);
      } else {
        zonePhotos.push(payload);
      }
    });

    return res.json({
      zoom,
      count: visible.length,
      photos: visible,
      homePhotos,
      zonePhotos,
    });
  } catch (err) {
    console.error('TrashTalk map error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/photos', async (req, res) => {
  try {
    const context = await getViewerContext(req).catch(() => ({ viewerId: null }));
    const viewerId = context.viewerId;
    const targetMemberId =
      req.query?.member_id ||
      req.query?.memberId ||
      viewerId;

    if (!targetMemberId) {
      return res.status(400).json({ error: 'member_id_required' });
    }

    const limit = clampNumber(req.query?.limit, 1, 500, 100);
    const offset = clampNumber(req.query?.offset, 0, 5000, 0);
    const { photos, total } = await fetchMemberPhotosWithVisibility({
      memberId: targetMemberId,
      viewerId,
      limit,
      offset,
    });

    return res.json({
      ok: true,
      member_id: targetMemberId,
      owner: !!viewerId && viewerId === targetMemberId,
      total,
      count: photos.length,
      pagination: { limit, offset },
      photos,
    });
  } catch (err) {
    console.error('trashtalk.photos error', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photos_fetch_failed' });
  }
});

router.get('/photo/:photoId', async (req, res) => {
  const photoId = (req.params.photoId || '').trim();
  if (!UUID_PATTERN.test(photoId)) {
    return res.status(400).json({ error: 'invalid_photo_id' });
  }

  try {
    const context = await getViewerContext(req).catch(() => ({ viewerId: null }));
    const viewerId = context.viewerId;
    const params = [photoId];
    const visibilityClause = appendVisibilityFilter({ viewerId, alias: 'vis', params });

    const sql = `
      SELECT
        p.photo_id,
        p.member_id,
        p.handle,
        p.r2_key,
        p.original_filename,
        p.mime_type,
        p.lat,
        p.lon,
        p.taken_at,
        p.created_at,
        vis.audience_mode,
        vis.relationship_tiers,
        vis.party_id,
        vis.allowed_member_ids,
        vis.expires_at,
        vis.policy_updated_at
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      WHERE p.photo_id = $1
        AND ${visibilityClause}
      LIMIT 1;
    `;

    const { rows } = await pool.query(sql, params);
    if (!rows.length) {
      return res.status(404).json({ error: 'photo_not_found' });
    }

    const ownerIds = collectOwnerIds(rows);
    const { zonesByMember, tiersByOwner } = await buildPrivacyContext(
      ownerIds,
      viewerId
    );
    const { visible, obscured } = applyPrivacyZones(rows, {
      viewerId,
      zonesByMember,
      tiersByOwner,
    });
    const sanitizedRow =
      (obscured.length && obscured[0].item) ||
      (visible.length && visible[0]) ||
      rows[0];

    return res.json({
      ok: true,
      photo: {
        photo_id: sanitizedRow.photo_id,
        member_id: sanitizedRow.member_id,
        handle: sanitizedRow.handle,
        r2_key: sanitizedRow.r2_key,
        original_filename: sanitizedRow.original_filename,
        mime_type: sanitizedRow.mime_type,
        lat: sanitizedRow.lat,
        lon: sanitizedRow.lon,
        taken_at: sanitizedRow.taken_at,
        created_at: sanitizedRow.created_at,
        visibility: formatVisibilityRow(sanitizedRow),
        obscured_zone: sanitizedRow.obscured_zone || null,
      },
    });
  } catch (err) {
    console.error('trashtalk.photo fetch failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_fetch_failed' });
  }
});

router.get('/visibility/overview', async (req, res) => {
  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.query?.member_id ||
      req.query?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const [policy, sets, summary] = await Promise.all([
      fetchMemberPolicy(memberId),
      fetchPhotoSets(memberId),
      fetchVisibilitySummary(memberId),
    ]);

    return res.json({
      ok: true,
      member_id: memberId,
      policy,
      sets,
      summary,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('visibility.overview error', err);
    return res.status(status).json({ error: err.message || 'visibility_overview_failed' });
  }
});

router.post('/visibility/policy', async (req, res) => {
  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const nextMode = normalizeAudienceMode(
      req.body?.default_audience_mode || req.body?.defaultAudienceMode,
      'public'
    );
    const nextTiers = normalizeRelationshipTiers(
      req.body?.default_relationship_tiers || req.body?.defaultRelationshipTiers || DEFAULT_RELATIONSHIP_TIERS
    );
    const requestedScope =
      typeof req.body?.default_party_scope === 'string'
        ? req.body.default_party_scope.trim().toLowerCase()
        : typeof req.body?.defaultPartyScope === 'string'
        ? req.body.defaultPartyScope.trim().toLowerCase()
        : 'attended';
    const allowedScopes = new Set(['none', 'attended', 'hosted_only']);
    const defaultPartyScope = allowedScopes.has(requestedScope)
      ? requestedScope
      : 'attended';
    const autoShare = req.body?.auto_share_current_party !== false &&
      req.body?.autoShareCurrentParty !== false;

    const { rows } = await pool.query(
      `
        INSERT INTO tt_member_photo_policy (
          member_id,
          default_audience_mode,
          default_relationship_tiers,
          default_party_scope,
          auto_share_current_party,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (member_id)
        DO UPDATE SET
          default_audience_mode = EXCLUDED.default_audience_mode,
          default_relationship_tiers = EXCLUDED.default_relationship_tiers,
          default_party_scope = EXCLUDED.default_party_scope,
          auto_share_current_party = EXCLUDED.auto_share_current_party,
          updated_at = NOW()
        RETURNING *
      `,
      [memberId, nextMode, nextTiers, defaultPartyScope, autoShare]
    );

    return res.json({ ok: true, policy: formatPolicyRow(rows[0]) });
  } catch (err) {
    console.error('visibility.policy save failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'policy_save_failed' });
  }
});

router.post('/visibility/sets', async (req, res) => {
  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!rawLabel) {
      return res.status(400).json({ error: 'label_required' });
    }

    const description =
      typeof req.body?.description === 'string' ? req.body.description.trim() : null;
    const defaultModeRaw =
      req.body?.default_audience_mode ||
      req.body?.defaultAudienceMode ||
      null;
    const defaultMode = defaultModeRaw ? normalizeAudienceMode(defaultModeRaw, 'public') : null;
    const defaultTiers =
      defaultMode === 'relationships'
        ? normalizeRelationshipTiers(
            req.body?.default_relationship_tiers || req.body?.defaultRelationshipTiers
          )
        : null;
    const defaultPartyId = req.body?.default_party_id || req.body?.defaultPartyId || null;

    const { rows } = await pool.query(
      `
        INSERT INTO tt_photo_set (
          member_id,
          label,
          description,
          default_audience_mode,
          default_relationship_tiers,
          default_party_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::uuid, NOW(), NOW())
        RETURNING *
      `,
      [memberId, rawLabel, description, defaultMode, defaultTiers, defaultPartyId]
    );

    return res.json({ ok: true, set: formatPhotoSetRow(rows[0]) });
  } catch (err) {
    console.error('visibility.sets create failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_set_create_failed' });
  }
});

router.patch('/visibility/sets/:setId', async (req, res) => {
  const setId = Number(req.params.setId);
  if (!Number.isFinite(setId)) {
    return res.status(400).json({ error: 'invalid_set_id' });
  }

  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const updates = [];
    const params = [setId, memberId];

    if (typeof req.body?.label === 'string') {
      updates.push(`label = $${params.length + 1}`);
      params.push(req.body.label.trim());
    }

    if (typeof req.body?.description === 'string') {
      updates.push(`description = $${params.length + 1}`);
      params.push(req.body.description.trim());
    }

    if ('default_audience_mode' in req.body || 'defaultAudienceMode' in req.body) {
      const modeRaw = req.body?.default_audience_mode || req.body?.defaultAudienceMode;
      updates.push(`default_audience_mode = $${params.length + 1}`);
      params.push(modeRaw ? normalizeAudienceMode(modeRaw, 'public') : null);
    }

    if ('default_relationship_tiers' in req.body || 'defaultRelationshipTiers' in req.body) {
      const tiersRaw =
        req.body?.default_relationship_tiers || req.body?.defaultRelationshipTiers;
      updates.push(`default_relationship_tiers = $${params.length + 1}`);
      params.push(Array.isArray(tiersRaw) ? normalizeRelationshipTiers(tiersRaw) : null);
    }

    if ('default_party_id' in req.body || 'defaultPartyId' in req.body) {
      const partyId = req.body?.default_party_id || req.body?.defaultPartyId || null;
      updates.push(`default_party_id = $${params.length + 1}::uuid`);
      params.push(partyId);
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'no_updates_provided' });
    }

    updates.push('updated_at = NOW()');

    const sql = `
      UPDATE tt_photo_set
         SET ${updates.join(', ')}
       WHERE photo_set_id = $1
         AND member_id = $2
       RETURNING *
    `;

    const { rows } = await pool.query(sql, params);
    if (!rows.length) {
      return res.status(404).json({ error: 'photo_set_not_found' });
    }

    return res.json({ ok: true, set: formatPhotoSetRow(rows[0]) });
  } catch (err) {
    console.error('visibility.sets update failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_set_update_failed' });
  }
});

router.delete('/visibility/sets/:setId', async (req, res) => {
  const setId = Number(req.params.setId);
  if (!Number.isFinite(setId)) {
    return res.status(400).json({ error: 'invalid_set_id' });
  }

  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rowCount } = await pool.query(
      `
        DELETE FROM tt_photo_set
        WHERE photo_set_id = $1
          AND member_id = $2
      `,
      [setId, memberId]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'photo_set_not_found' });
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('visibility.sets delete failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_set_delete_failed' });
  }
});

router.post('/visibility/sets/:setId/photos', async (req, res) => {
  const setId = Number(req.params.setId);
  if (!Number.isFinite(setId)) {
    return res.status(400).json({ error: 'invalid_set_id' });
  }

  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows: setRows } = await pool.query(
      `
        SELECT photo_set_id
          FROM tt_photo_set
         WHERE photo_set_id = $1
           AND member_id = $2
         LIMIT 1
      `,
      [setId, memberId]
    );

    if (!setRows.length) {
      return res.status(404).json({ error: 'photo_set_not_found' });
    }

    const addIds = parsePhotoIds(req.body?.add || req.body?.photo_ids || []);
    const removeIds = parsePhotoIds(req.body?.remove || []);
    let added = 0;
    let removed = 0;

    if (addIds.length) {
      await ensurePhotosOwnedBy(memberId, addIds);
      const { rowCount } = await pool.query(
        `
      INSERT INTO tt_photo_set_item (photo_set_id, photo_id)
      SELECT $1, unnest($2::uuid[])
          ON CONFLICT DO NOTHING
        `,
        [setId, addIds]
      );
      added = rowCount;
    }

    if (removeIds.length) {
      const { rowCount } = await pool.query(
        `
          DELETE FROM tt_photo_set_item
          WHERE photo_set_id = $1
      AND photo_id = ANY($2::uuid[])
        `,
        [setId, removeIds]
      );
      removed = rowCount;
    }

    return res.json({
      ok: true,
      added,
      removed,
    });
  } catch (err) {
    console.error('visibility.sets photos update failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_set_membership_failed' });
  }
});

router.post('/photo/visibility', async (req, res) => {
  try {
    const { viewerId } = await getViewerContext(req, { requireAuth: true });
    const memberId =
      req.body?.member_id ||
      req.body?.memberId ||
      viewerId;

    if (!memberId || viewerId !== memberId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const photoIds =
      parsePhotoIds(req.body?.photo_ids || req.body?.photoIds) ||
      [];

    if (!photoIds.length) {
      return res.status(400).json({ error: 'photo_ids_required' });
    }

    await ensurePhotosOwnedBy(memberId, photoIds);

    const action = typeof req.body?.action === 'string'
      ? req.body.action.trim().toLowerCase()
      : 'set';

    if (action === 'clear') {
      const { rowCount } = await pool.query(
        `
          DELETE FROM tt_photo_visibility
        WHERE photo_id = ANY($1::uuid[])
            AND photo_id IN (
              SELECT photo_id
              FROM tt_photo
              WHERE member_id = $2
            )
        `,
        [photoIds, memberId]
      );
      return res.json({ ok: true, cleared: rowCount });
    }

    const audienceMode = normalizeAudienceMode(
      req.body?.audience_mode || req.body?.audienceMode,
      'public'
    );
    const relationshipTiers = normalizeRelationshipTiers(
      req.body?.relationship_tiers || req.body?.relationshipTiers
    );
    const allowedMembers = normalizeAllowedMembers(
      req.body?.allowed_member_ids || req.body?.allowedMemberIds
    );
    const partyId = req.body?.party_id || req.body?.partyId || null;
    const expiresAt = normalizeDate(req.body?.expires_at || req.body?.expiresAt);

    if (audienceMode === 'custom_list' && !allowedMembers.length) {
      return res.status(400).json({ error: 'allowed_members_required' });
    }

    const { rows } = await pool.query(
      `
        INSERT INTO tt_photo_visibility (
          photo_id,
          audience_mode,
          relationship_tiers,
          party_id,
          allowed_member_ids,
          expires_at,
          created_at,
          updated_at
        )
        SELECT
          photo_id,
          $2,
          $3,
          $4::uuid,
          $5,
          $6,
          NOW(),
          NOW()
        FROM tt_photo
        WHERE member_id = $1
          AND photo_id = ANY($7::uuid[])
        ON CONFLICT (photo_id)
        DO UPDATE SET
          audience_mode = EXCLUDED.audience_mode,
          relationship_tiers = EXCLUDED.relationship_tiers,
          party_id = EXCLUDED.party_id,
          allowed_member_ids = EXCLUDED.allowed_member_ids,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
        RETURNING photo_id
      `,
      [memberId, audienceMode, relationshipTiers, partyId, allowedMembers, expiresAt, photoIds]
    );

    return res.json({ ok: true, updated: rows.length });
  } catch (err) {
    console.error('photo.visibility bulk update failed', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'photo_visibility_update_failed' });
  }
});

router.delete('/photo/:photoId', async (req, res) => {
  try {
    const photoId = (req.params.photoId || '').trim();
    if (!UUID_PATTERN.test(photoId)) {
      return res.status(400).json({ error: 'Invalid photo id.' });
    }

    const me = await getCurrentIdentity(req, pool);
    if (!me || !me.handle) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const { rows } = await pool.query(
      `
        DELETE FROM tt_photo
        WHERE photo_id = $1
          AND handle = $2
        RETURNING photo_id, r2_key;
      `,
      [photoId, me.handle]
    );

      if (!rows.length) {
        return res.status(404).json({ error: 'Photo not found.' });
      }

      const r2Key = rows[0].r2_key;
      if (r2Key) {
        try {
          await deleteFromR2({ key: r2Key });
        } catch (r2Err) {
          console.error('TrashTalk delete R2 object error', {
            key: r2Key,
            photoId,
            handle: me.handle,
            message: r2Err.message,
          });
        }
      }

    return res.json({ deleted: true, photo_id: photoId });
  } catch (err) {
    console.error('TrashTalk delete photo error', err);
    return res.status(500).json({ error: 'Failed to delete photo.' });
  }
});
// in trashtalk.js (or wherever party routes live)
module.exports = router;
