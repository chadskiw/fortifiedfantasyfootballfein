// routes/roadtrip.js
const express = require('express');
const pool = require('../src/db/pool'); // adjust path if needed
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();

const PUBLIC_VIEWER_HANDLE = (
  process.env.PUBLIC_VIEWER_HANDLE || 'PUBGHOST'
)
  .trim()
  .toUpperCase();

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
function haversineMeters(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return 0;
  }
  const R = 6371e3; // meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const latRad1 = toRad(lat1);
  const latRad2 = toRad(lat2);
  const dLat = latRad2 - latRad1;
  const dLon = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(latRad1) * Math.cos(latRad2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function distanceOfPlannedPath(plannedPath) {
  if (!Array.isArray(plannedPath) || plannedPath.length < 2) return 0;

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
    total += haversineMeters(a.lat, a.lon, b.lat, b.lon);
  }
  return Math.round(total);
}
function normalizeMediaKind(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'image') return 'photo';
  if (raw === 'photo' || raw === 'pic' || raw === 'picture') return 'photo';
  if (raw === 'video' || raw === 'clip') return 'video';
  if (raw === 'audio' || raw === 'sound' || raw === 'voice') return 'audio';
  if (raw === 'mixed' || raw === 'combo') return 'mixed';
  return null;
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

const ROADTRIP_LAYOUT_SIZES = new Set([
  'mini',
  'small',
  'medium',
  'wide',
  'tall',
  'hero',
]);

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGIT_ID_RE = /^\d+$/;

let layoutTableEnsured = false;
let liveTablesEnsured = false;
let cachedObjectIdColumnType = null;
let mediaColumnsEnsured = false;
let objectKindConstraintsEnsured = false;

function normalizeObjectIdColumnType(rawType) {
  if (!rawType) return 'UUID';
  const val = String(rawType).toLowerCase().trim();
  if (val === 'int8' || val === 'bigint') return 'BIGINT';
  if (val === 'int4' || val === 'integer') return 'INTEGER';
  if (val.includes('uuid')) return 'UUID';
  return 'UUID';
}

async function resolveRoadtripObjectIdColumnType() {
  if (cachedObjectIdColumnType) return cachedObjectIdColumnType;
  try {
    const { rows } = await pool.query(
      `
      SELECT data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tt_party_roadtrip_object'
        AND column_name = 'object_id'
      LIMIT 1
      `
    );
    if (rows[0]) {
      const detected = normalizeObjectIdColumnType(
        rows[0].udt_name || rows[0].data_type
      );
      cachedObjectIdColumnType = detected;
      return detected;
    }
  } catch (err) {
    console.warn(
      '[roadtrip] unable to introspect object_id type, defaulting to UUID',
      err.message
    );
  }
  cachedObjectIdColumnType = 'UUID';
  return cachedObjectIdColumnType;
}

async function ensureRoadtripLayoutTable() {
  if (layoutTableEnsured) return;

  const attemptEnsure = async () => {
    const objectIdType = await resolveRoadtripObjectIdColumnType();
    const ddl = `
      CREATE TABLE IF NOT EXISTS tt_party_roadtrip_object_layout (
        object_id ${objectIdType} PRIMARY KEY REFERENCES tt_party_roadtrip_object(object_id) ON DELETE CASCADE,
        roadtrip_id UUID NOT NULL REFERENCES tt_party_roadtrip(roadtrip_id) ON DELETE CASCADE,
        display_order INTEGER DEFAULT 0,
        size_hint TEXT DEFAULT 'medium',
        sticker_label TEXT,
        sticker_color TEXT,
        meta JSONB DEFAULT '{}'::jsonb,
        deleted BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS tt_party_roadtrip_object_layout_rid_idx
        ON tt_party_roadtrip_object_layout(roadtrip_id, display_order);
    `;
    await pool.query(ddl);
    layoutTableEnsured = true;
  };

  try {
    await attemptEnsure();
  } catch (err) {
    const isTypeMismatch =
      err?.code === '42804' ||
      /incompatible types/i.test(err?.detail || '') ||
      /incompatible types/i.test(err?.message || '');

    if (!isTypeMismatch) {
      console.error('[roadtrip] failed to ensure layout table', err);
      return;
    }

    console.warn(
      '[roadtrip] layout table DDL failed due to object_id type mismatch, retrying with fresh introspection'
    );
    cachedObjectIdColumnType = null;

    try {
      await attemptEnsure();
    } catch (retryErr) {
      console.error('[roadtrip] failed to ensure layout table after retry', retryErr);
    }
  }
}

async function ensureRoadtripMediaColumns() {
  if (mediaColumnsEnsured) return;
  const ddl = `
    ALTER TABLE tt_party_roadtrip_object
      ADD COLUMN IF NOT EXISTS media_url TEXT;
    ALTER TABLE tt_party_roadtrip_object
      ADD COLUMN IF NOT EXISTS media_mime TEXT;
    ALTER TABLE tt_party_roadtrip_object
      ADD COLUMN IF NOT EXISTS media_bytes BIGINT;
  `;
  try {
    await pool.query(ddl);
    mediaColumnsEnsured = true;
  } catch (err) {
    console.error('[roadtrip] failed to ensure media columns', err);
  }
}

async function ensureRoadtripLiveTables() {
  if (liveTablesEnsured) return;
  const ddl = `
CREATE TABLE IF NOT EXISTS tt_party_roadtrip_session (
  session_id UUID PRIMARY KEY,
  roadtrip_id UUID NOT NULL REFERENCES tt_party_roadtrip(roadtrip_id) ON DELETE CASCADE,
  host_member_id TEXT NOT NULL REFERENCES ff_member(member_id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  state TEXT DEFAULT 'live',
  last_lat DOUBLE PRECISION,
  last_lon DOUBLE PRECISION,
  last_ping_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

    CREATE INDEX IF NOT EXISTS tt_party_roadtrip_session_live_idx
      ON tt_party_roadtrip_session(roadtrip_id, state)
      WHERE state = 'live';

    CREATE TABLE IF NOT EXISTS tt_party_roadtrip_trace (
      trace_id UUID PRIMARY KEY,
      roadtrip_id UUID NOT NULL REFERENCES tt_party_roadtrip(roadtrip_id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES tt_party_roadtrip_session(session_id) ON DELETE CASCADE,
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tt_party_roadtrip_trace_rid_idx
      ON tt_party_roadtrip_trace(roadtrip_id, recorded_at);
  `;
  try {
    await pool.query(ddl);
    liveTablesEnsured = true;
  } catch (err) {
    console.error('[roadtrip] failed to ensure live tables', err);
  }
}

function quoteIdent(name) {
  if (!name) return '""';
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPublicViewerOverride(req) {
  if (!PUBLIC_VIEWER_HANDLE) return null;
  const raw =
    req.query?.viewerId ||
    req.query?.viewer_id ||
    req.headers?.['x-public-viewer'] ||
    req.headers?.['x-public-viewer-id'];
  if (!raw) return null;
  const normalized = String(raw).trim().toUpperCase();
  return normalized === PUBLIC_VIEWER_HANDLE ? PUBLIC_VIEWER_HANDLE : null;
}

async function ensureRoadtripObjectKindConstraints(force = false) {
  if (objectKindConstraintsEnsured && !force) return;
  const orderedKinds = Array.from(ROADTRIP_OBJECT_KINDS);

  try {
    const { rows } = await pool.query(
      `
        SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tt_party_roadtrip_object'
          AND column_name = 'kind'
        LIMIT 1
      `
    );
    const column = rows[0];
    if (column && column.data_type === 'USER-DEFINED' && column.udt_name) {
      const enumName = quoteIdent(column.udt_name);
      for (const kind of orderedKinds) {
        const literal = quoteLiteral(kind);
        const sql = `
          DO $$
          BEGIN
            ALTER TYPE ${enumName}
              ADD VALUE IF NOT EXISTS ${literal};
          EXCEPTION
            WHEN duplicate_object THEN NULL;
          END $$;
        `;
        await pool.query(sql);
      }
    }
  } catch (err) {
    console.warn('[roadtrip] unable to extend roadtrip object kind enum', err.message);
  }

  try {
    const { rows } = await pool.query(
      `
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'tt_party_roadtrip_object'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%kind%'
      `
    );
    for (const row of rows) {
      const definition = String(row.definition || '').toLowerCase();
      const missingKind = orderedKinds.some(
        (kind) => !definition.includes(`'${kind.toLowerCase()}'`)
      );
      if (!missingKind) continue;
      const constraintName = row.conname
        ? quoteIdent(row.conname)
        : quoteIdent('tt_party_roadtrip_object_kind_check');
      const allowedList = orderedKinds
        .map((kind) => quoteLiteral(kind))
        .join(', ');
      await pool.query(
        `ALTER TABLE tt_party_roadtrip_object DROP CONSTRAINT IF EXISTS ${constraintName}`
      );
      await pool.query(
        `
          ALTER TABLE tt_party_roadtrip_object
          ADD CONSTRAINT ${constraintName}
            CHECK (kind = ANY(ARRAY[${allowedList}]::text[]))
        `
      );
      break;
    }
  } catch (err) {
    console.warn('[roadtrip] unable to refresh roadtrip kind constraint', err.message);
  }

  objectKindConstraintsEnsured = true;
}

function coerceLayoutSize(input) {
  if (!input) return null;
  const size = String(input).toLowerCase().trim();
  if (ROADTRIP_LAYOUT_SIZES.has(size)) {
    return size;
  }
  return null;
}

function sanitizeSticker(sticker) {
  if (!sticker) return { label: null, color: null };
  const label =
    typeof sticker.label === 'string'
      ? sticker.label.trim().slice(0, 80)
      : null;
  const rawColor =
    typeof sticker.color === 'string' ? sticker.color.trim() : null;
  const color = rawColor && HEX_COLOR_RE.test(rawColor) ? rawColor : null;
  if (!label && !color) return { label: null, color: null };
  return { label, color };
}

function normalizeDisplayOrder(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function isValidUuid(value) {
  if (!value) return false;
  return UUID_RE.test(String(value));
}

function isValidObjectId(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  const str = String(value).trim();
  if (!str) return false;
  if (UUID_RE.test(str)) return true;
  if (DIGIT_ID_RE.test(str)) return true;
  return false;
}

function coerceIsoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function loadRoadtripLiveState(roadtripId, sessionPreference) {
  if (!roadtripId) {
    return {
      sessions: [],
      trace: [],
      trace_session_id: null,
    };
  }
  await ensureRoadtripLiveTables();
  const { rows: sessionRows } = await pool.query(
    `
    SELECT
      session_id,
      roadtrip_id,
      host_member_id,
      started_at,
      ended_at,
      state,
      last_lat,
      last_lon,
      last_ping_at
    FROM tt_party_roadtrip_session
    WHERE roadtrip_id = $1
    ORDER BY started_at DESC
    LIMIT 12
    `,
    [roadtripId]
  );
  const sessions = sessionRows || [];

  let traceSessionId = null;
  if (sessionPreference && isValidUuid(sessionPreference)) {
    traceSessionId =
      sessions.find((session) => session.session_id === sessionPreference)
        ?.session_id || null;
  }
  if (!traceSessionId && sessions.length) {
    traceSessionId =
      sessions.find((session) => session.state === 'live')?.session_id ||
      sessions[0].session_id;
  }

  let trace = [];
  if (traceSessionId) {
    const { rows: traceRows } = await pool.query(
      `
      SELECT
        trace_id,
        session_id,
        roadtrip_id,
        recorded_at,
        lat,
        lon
      FROM tt_party_roadtrip_trace
      WHERE roadtrip_id = $1
        AND session_id = $2
      ORDER BY recorded_at ASC
      LIMIT 2000
      `,
      [roadtripId, traceSessionId]
    );
    trace = traceRows || [];
  }

  return {
    sessions,
    trace,
    trace_session_id: traceSessionId,
  };
}

async function insertTracePointForSession({
  roadtripId,
  session,
  lat,
  lon,
  recordedAtIso,
}) {
  if (
    !session ||
    !isValidUuid(session.session_id) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }
  await ensureRoadtripLiveTables();
  const prevLat = Number(session.last_lat);
  const prevLon = Number(session.last_lon);
  const prevPing = session.last_ping_at
    ? new Date(session.last_ping_at)
    : null;
  const currentTs = recordedAtIso ? new Date(recordedAtIso) : new Date();
  const currentIso = currentTs.toISOString();

  if (
    Number.isFinite(prevLat) &&
    Number.isFinite(prevLon) &&
    prevPing &&
    !Number.isNaN(prevPing.getTime())
  ) {
    const distMeters = haversineMeters(prevLat, prevLon, lat, lon);
    const deltaMs = Math.abs(currentTs.getTime() - prevPing.getTime());
    if (distMeters < 5 && deltaMs < 4000) {
      return null;
    }
  }

  const { rows } = await pool.query(
    `
    INSERT INTO tt_party_roadtrip_trace (
      trace_id,
      roadtrip_id,
      session_id,
      recorded_at,
      lat,
      lon
    )
    VALUES (
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      $5
    )
    RETURNING *
    `,
    [roadtripId, session.session_id, currentIso, lat, lon]
  );
  return rows[0] || null;
}

function shapeRoadtripObject(row) {
  if (!row) return row;
  const {
    layout_order,
    layout_size,
    layout_sticker_label,
    layout_sticker_color,
    layout_meta,
    layout_deleted,
    ...rest
  } = row;

  const hasLayout =
    layout_order !== null ||
    !!layout_size ||
    !!layout_sticker_label ||
    !!layout_sticker_color ||
    layout_meta != null ||
    layout_deleted != null;

  const layout = hasLayout
    ? {
        order: layout_order,
        size: layout_size || null,
        sticker:
          layout_sticker_label || layout_sticker_color
            ? {
                label: layout_sticker_label || null,
                color: layout_sticker_color || null,
              }
            : null,
        meta: layout_meta || null,
        deleted: Boolean(layout_deleted),
      }
    : null;

  return {
    ...rest,
    layout,
  };
}

function mapLayoutRow(row) {
  if (!row) return null;
  return {
    object_id: row.object_id,
    roadtrip_id: row.roadtrip_id,
    order: row.display_order,
    size: row.size_hint || null,
    sticker:
      row.sticker_label || row.sticker_color
        ? {
            label: row.sticker_label || null,
            color: row.sticker_color || null,
          }
        : null,
    meta: row.meta || null,
    deleted: Boolean(row.deleted),
    updated_at: row.updated_at || null,
  };
}

async function upsertLayoutRow(roadtripId, objectId, patch = {}) {
  if (!isValidObjectId(objectId)) {
    throw new Error('invalid_object_id');
  }
  await ensureRoadtripLayoutTable();
  await pool.query(
    `
    INSERT INTO tt_party_roadtrip_object_layout (object_id, roadtrip_id)
    VALUES ($1, $2)
    ON CONFLICT (object_id) DO NOTHING
    `,
    [objectId, roadtripId]
  );

  const assignments = [];
  const values = [];
  let paramIndex = 3;

  if (hasOwn(patch, 'order') || hasOwn(patch, 'display_order')) {
    const orderValue = normalizeDisplayOrder(
      hasOwn(patch, 'order') ? patch.order : patch.display_order
    );
    assignments.push(`display_order = $${paramIndex++}`);
    values.push(orderValue);
  }

  if (hasOwn(patch, 'size') || hasOwn(patch, 'size_hint')) {
    const sizeValue =
      coerceLayoutSize(hasOwn(patch, 'size') ? patch.size : patch.size_hint) ||
      null;
    assignments.push(`size_hint = $${paramIndex++}`);
    values.push(sizeValue);
  }

  if (hasOwn(patch, 'sticker')) {
    const { label, color } = sanitizeSticker(patch.sticker);
    assignments.push(`sticker_label = $${paramIndex++}`);
    values.push(label);
    assignments.push(`sticker_color = $${paramIndex++}`);
    values.push(color);
  }

  if (hasOwn(patch, 'meta')) {
    let metaString = null;
    if (patch.meta && typeof patch.meta === 'object') {
      try {
        metaString = JSON.stringify(patch.meta);
      } catch (err) {
        metaString = null;
      }
    }
    assignments.push(`meta = COALESCE($${paramIndex++}::jsonb, '{}'::jsonb)`);
    values.push(metaString);
  }

  if (hasOwn(patch, 'deleted')) {
    assignments.push(`deleted = $${paramIndex++}`);
    values.push(Boolean(patch.deleted));
  }

  if (!assignments.length) {
    return null;
  }

  const { rows } = await pool.query(
    `
    UPDATE tt_party_roadtrip_object_layout
    SET ${assignments.join(', ')}, updated_at = NOW()
    WHERE object_id = $1 AND roadtrip_id = $2
    RETURNING *
    `,
    [objectId, roadtripId, ...values]
  );

  return mapLayoutRow(rows[0]);
}

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

async function resolveRoadtripViewer(req, roadtrip) {
  const publicOverrideId = getPublicViewerOverride(req);
  if (publicOverrideId) {
    return {
      member_id: publicOverrideId,
      handle: PUBLIC_VIEWER_HANDLE,
      role: 'public',
      public_override: true,
    };
  }

  let viewerMemberId = null;
  try {
    viewerMemberId = await resolveMemberId(req);
  } catch (err) {
    console.warn('[roadtrip] viewer identity lookup failed', err.message);
  }

  const viewer = {
    member_id: viewerMemberId ? String(viewerMemberId) : null,
    handle: null,
    role: 'public',
  };

  if (!viewer.member_id || !roadtrip) {
    return viewer;
  }

  const normalizedHostId = roadtrip.host_member_id
    ? String(roadtrip.host_member_id)
    : null;

  if (normalizedHostId && normalizedHostId === viewer.member_id) {
    viewer.role = 'host';
  } else if (roadtrip.party_id) {
    try {
      const membership = await pool.query(
        `
          SELECT 1
          FROM tt_party_member
          WHERE party_id = $1
            AND member_id = $2
          LIMIT 1
        `,
        [roadtrip.party_id, viewer.member_id]
      );
      if (membership.rowCount) {
        viewer.role = 'member';
      }
    } catch (err) {
      console.warn('[roadtrip] viewer membership lookup failed', err.message);
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT handle FROM ff_member WHERE member_id = $1 LIMIT 1`,
      [viewer.member_id]
    );
    if (rows[0]?.handle) {
      viewer.handle = rows[0].handle;
    }
  } catch (err) {
    console.warn('[roadtrip] viewer handle lookup failed', err.message);
  }

  return viewer;
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
  const liveSessionPreference =
    req.query?.live_session || req.query?.liveSession || null;

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
    const viewer = await resolveRoadtripViewer(req, roadtrip);

    await ensureRoadtripLayoutTable();

   const objectsPromise = pool.query(
  `
  SELECT
    o.*,
    m.handle,
    lay.display_order AS layout_order,
    lay.size_hint   AS layout_size,
    lay.sticker_label AS layout_sticker_label,
    lay.sticker_color AS layout_sticker_color,
    lay.meta AS layout_meta,
    lay.deleted AS layout_deleted
  FROM tt_party_roadtrip_object o
  LEFT JOIN ff_member m
    ON m.member_id = o.member_id
  LEFT JOIN tt_party_roadtrip_object_layout lay
    ON lay.object_id = o.object_id
  WHERE o.roadtrip_id = $1
  ORDER BY
    COALESCE(lay.display_order, 1000000) ASC,
    o.at_time ASC NULLS LAST,
    o.object_id ASC
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

    const objects = objectsResult.rows.map(shapeRoadtripObject);
    const liveState = await loadRoadtripLiveState(
      roadtrip.roadtrip_id,
      liveSessionPreference
    );

    return res.json({
      ok: true,
      roadtrip,
      objects,
      playlist: playlistResult.rows,
      live_sessions: liveState.sessions,
      live_trace: liveState.trace,
      live_trace_session_id: liveState.trace_session_id,
      viewer,
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

router.post('/:roadtripId/live/start', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const { lat, lon, at_time } = req.body || {};
  let latNumber = null;
  let lonNumber = null;

  if (lat !== undefined && lat !== null && lat !== '') {
    latNumber = Number(lat);
    if (!Number.isFinite(latNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'lat must be a valid number',
      });
    }
  }

  if (lon !== undefined && lon !== null && lon !== '') {
    lonNumber = Number(lon);
    if (!Number.isFinite(lonNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'lon must be a valid number',
      });
    }
  }

  const recordedAtIso = coerceIsoTimestamp(at_time);

  try {
    await ensureRoadtripLiveTables();
    let closedSessions = 0;
    try {
      const { rowCount } = await pool.query(
        `
        UPDATE tt_party_roadtrip_session
        SET state = 'ended', ended_at = NOW()
        WHERE roadtrip_id = $1
          AND state = 'live'
        `,
        [roadtripId]
      );
      closedSessions = rowCount;
    } catch (err) {
      console.warn('[roadtrip] unable to close prior live sessions', err.message);
    }

    const insertResult = await pool.query(
      `
      INSERT INTO tt_party_roadtrip_session (
        session_id,
        roadtrip_id,
        host_member_id,
        started_at,
        state,
        last_lat,
        last_lon,
        last_ping_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        COALESCE($3, NOW()),
        'live',
        $4,
        $5,
        COALESCE($6, NOW())
      )
      RETURNING *
      `,
      [
        roadtripId,
        hostContext.actorMemberId,
        recordedAtIso,
        latNumber,
        lonNumber,
        recordedAtIso,
      ]
    );

    const session = insertResult.rows[0] || null;
    let tracePoint = null;
    if (
      session &&
      Number.isFinite(latNumber) &&
      Number.isFinite(lonNumber)
    ) {
      tracePoint = await insertTracePointForSession({
        roadtripId,
        session,
        lat: latNumber,
        lon: lonNumber,
        recordedAtIso,
      });
    }

    try {
      await pool.query(
        `
        UPDATE tt_party_roadtrip
        SET state = 'live'
        WHERE roadtrip_id = $1
        `,
        [roadtripId]
      );
    } catch (stateErr) {
      console.warn('[roadtrip] unable to bump roadtrip state', stateErr.message);
    }

    return res.status(201).json({
      ok: true,
      session,
      trace_point: tracePoint,
      closed_sessions: closedSessions,
    });
  } catch (err) {
    console.error('[roadtrip] failed to start live session', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to start live session',
    });
  }
});

router.post('/:roadtripId/live/ping', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }
  const { session_id } = req.body || {};
  if (!isValidUuid(session_id)) {
    return res.status(400).json({
      ok: false,
      error: 'session_id is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const { lat, lon, recorded_at } = req.body || {};
  const latNumber = Number(lat);
  const lonNumber = Number(lon);
  if (!Number.isFinite(latNumber) || !Number.isFinite(lonNumber)) {
    return res.status(400).json({
      ok: false,
      error: 'lat and lon must be numeric for live pings',
    });
  }

  const pingIso = coerceIsoTimestamp(recorded_at) || new Date().toISOString();

  try {
    await ensureRoadtripLiveTables();
    const { rows } = await pool.query(
      `
      SELECT *
      FROM tt_party_roadtrip_session
      WHERE session_id = $1
        AND roadtrip_id = $2
      LIMIT 1
      `,
      [session_id, roadtripId]
    );
    const session = rows[0] || null;
    if (!session) {
      return res.status(404).json({
        ok: false,
        error: 'Live session not found',
      });
    }
    if (session.state !== 'live') {
      return res.status(409).json({
        ok: false,
        error: 'Session is no longer live',
      });
    }
    const normalizedSessionHost = session.host_member_id
      ? String(session.host_member_id)
      : null;
    if (
      normalizedSessionHost &&
      normalizedSessionHost !== hostContext.actorMemberId
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Session belongs to another host',
      });
    }

    const tracePoint = await insertTracePointForSession({
      roadtripId,
      session,
      lat: latNumber,
      lon: lonNumber,
      recordedAtIso: pingIso,
    });

    const { rows: updatedRows } = await pool.query(
      `
      UPDATE tt_party_roadtrip_session
      SET
        last_lat = $1,
        last_lon = $2,
        last_ping_at = $3
      WHERE session_id = $4
      RETURNING *
      `,
      [latNumber, lonNumber, pingIso, session_id]
    );

    return res.json({
      ok: true,
      session: updatedRows[0] || null,
      trace_point: tracePoint,
    });
  } catch (err) {
    console.error('[roadtrip] live ping failed', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to record live ping',
    });
  }
});

router.post('/:roadtripId/live/end', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const { session_id, lat, lon, recorded_at } = req.body || {};
  let targetSessionId = null;
  if (session_id && isValidUuid(session_id)) {
    targetSessionId = session_id;
  }
  let latNumber = null;
  let lonNumber = null;
  if (lat !== undefined && lat !== null && lat !== '') {
    latNumber = Number(lat);
    if (!Number.isFinite(latNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'lat must be numeric when provided',
      });
    }
  }
  if (lon !== undefined && lon !== null && lon !== '') {
    lonNumber = Number(lon);
    if (!Number.isFinite(lonNumber)) {
      return res.status(400).json({
        ok: false,
        error: 'lon must be numeric when provided',
      });
    }
  }

  const endIso = coerceIsoTimestamp(recorded_at) || new Date().toISOString();

  try {
    await ensureRoadtripLiveTables();
    let sessionRow = null;
    if (targetSessionId) {
      const { rows } = await pool.query(
        `
        SELECT *
        FROM tt_party_roadtrip_session
        WHERE session_id = $1
          AND roadtrip_id = $2
        LIMIT 1
        `,
        [targetSessionId, roadtripId]
      );
      sessionRow = rows[0] || null;
    }
    if (!sessionRow) {
      const { rows } = await pool.query(
        `
        SELECT *
        FROM tt_party_roadtrip_session
        WHERE roadtrip_id = $1
          AND state = 'live'
        ORDER BY started_at DESC
        LIMIT 1
        `,
        [roadtripId]
      );
      sessionRow = rows[0] || null;
    }
    if (!sessionRow) {
      return res.status(404).json({
        ok: false,
        error: 'No live session to end',
      });
    }

    const normalizedSessionHost = sessionRow.host_member_id
      ? String(sessionRow.host_member_id)
      : null;
    if (
      normalizedSessionHost &&
      normalizedSessionHost !== hostContext.actorMemberId
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Session belongs to another host',
      });
    }

    let tracePoint = null;
    if (
      Number.isFinite(latNumber) &&
      Number.isFinite(lonNumber)
    ) {
      tracePoint = await insertTracePointForSession({
        roadtripId,
        session: sessionRow,
        lat: latNumber,
        lon: lonNumber,
        recordedAtIso: endIso,
      });
    }

    const { rows: updatedRows } = await pool.query(
      `
      UPDATE tt_party_roadtrip_session
      SET
        state = 'ended',
        ended_at = $2,
        last_lat = COALESCE($3, last_lat),
        last_lon = COALESCE($4, last_lon),
        last_ping_at = $5
      WHERE session_id = $1
      RETURNING *
      `,
      [
        sessionRow.session_id,
        endIso,
        Number.isFinite(latNumber) ? latNumber : null,
        Number.isFinite(lonNumber) ? lonNumber : null,
        endIso,
      ]
    );

    try {
      const { rows } = await pool.query(
        `
        SELECT 1
        FROM tt_party_roadtrip_session
        WHERE roadtrip_id = $1
          AND state = 'live'
        LIMIT 1
        `,
        [roadtripId]
      );
      if (!rows.length) {
        await pool.query(
          `
          UPDATE tt_party_roadtrip
          SET state = 'recap'
          WHERE roadtrip_id = $1
          `,
          [roadtripId]
        );
      }
    } catch (stateErr) {
      console.warn('[roadtrip] unable to finalize roadtrip state', stateErr.message);
    }

    return res.json({
      ok: true,
      session: updatedRows[0] || null,
      trace_point: tracePoint,
    });
  } catch (err) {
    console.error('[roadtrip] failed to end live session', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to end live session',
    });
  }
});

// POST /api/roadtrip/:roadtripId/objects
router.post('/:roadtripId/objects', async (req, res) => {
  const roadtripId = req.params.roadtripId;
  const {
    kind,
    title,
    body,
    lat,
    lon,
    at_time,
    photo_id,      // UUID from tt_photo
    video_r2_key,  // R2 key (short video)
    media_url,
    media_mime,
    media_bytes,
    media_kind: bodyMediaKind,
  } = req.body || {};

  if (!roadtripId || !kind) {
    return res.status(400).json({ ok: false, error: 'Missing roadtripId or kind' });
  }

  const memberId = req.ffMemberId || (req.ffMember && req.ffMember.member_id) || null;

  await ensureRoadtripMediaColumns();

  let media_kind = null;
  if (photo_id && video_r2_key) media_kind = 'mixed';
  else if (photo_id) media_kind = 'photo';
  else if (video_r2_key) media_kind = 'video';

  const normalizedBodyMediaKind = normalizeMediaKind(bodyMediaKind);
  if (!media_kind && normalizedBodyMediaKind) {
    media_kind = normalizedBodyMediaKind;
  }

  const mediaUrl =
    typeof media_url === 'string' && media_url.trim() ? media_url.trim() : null;
  const mediaMime =
    typeof media_mime === 'string' && media_mime.trim() ? media_mime.trim() : null;
  const mediaBytesNumber =
    media_bytes != null && media_bytes !== ''
      ? Number(media_bytes)
      : null;
  const mediaBytes =
    Number.isFinite(mediaBytesNumber) && mediaBytesNumber >= 0
      ? Math.round(mediaBytesNumber)
      : null;

  await ensureRoadtripObjectKindConstraints();

  const insertSql = `
      INSERT INTO tt_party_roadtrip_object (
        roadtrip_id, member_id, kind,
        lat, lon, at_time,
        title, body,
        photo_id, video_r2_key, media_kind,
        media_url, media_mime, media_bytes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *;
  `;

  const insertValues = [
    roadtripId,
    memberId,
    kind,
    lat ?? null,
    lon ?? null,
    at_time || null,
    title || null,
    body || null,
    photo_id || null,
    video_r2_key || null,
    media_kind,
    mediaUrl,
    mediaMime,
    mediaBytes,
  ];

  try {
    const insert = await pool.query(insertSql, insertValues);
    res.status(201).json({ ok: true, object: insert.rows[0] });
  } catch (err) {
    const needsRetry =
      err?.code === '22P02' ||
      err?.code === '23514';
    if (needsRetry) {
      console.warn('[roadtrip] object insert failed due to kind validation, retrying', err.message);
      objectKindConstraintsEnsured = false;
      try {
        await ensureRoadtripObjectKindConstraints(true);
        const retry = await pool.query(insertSql, insertValues);
        return res.status(201).json({ ok: true, object: retry.rows[0] });
      } catch (retryErr) {
        console.error('[roadtrip] failed to insert object after retry', retryErr);
        return res.status(500).json({ ok: false, error: 'Failed to insert object' });
      }
    }
    console.error('[roadtrip] failed to insert object', err);
    res.status(500).json({ ok: false, error: 'Failed to insert object' });
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

router.patch('/:roadtripId/objects/:objectId/layout', async (req, res) => {
  const { roadtripId, objectId } = req.params || {};
  if (!roadtripId || !objectId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId and objectId are required',
    });
  }
  if (!isValidObjectId(objectId)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid objectId',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  try {
    const layoutRow = await upsertLayoutRow(roadtripId, objectId, req.body || {});
    if (!layoutRow) {
      return res.status(400).json({
        ok: false,
        error: 'No layout changes provided',
      });
    }
    return res.json({
      ok: true,
      layout: layoutRow,
    });
  } catch (err) {
    console.error('[roadtrip] failed to update layout', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to update layout',
    });
  }
});

router.post('/:roadtripId/layout', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }

  const hostContext = await ensureRoadtripHost(req, res, roadtripId);
  if (!hostContext) return;

  const updates = Array.isArray(req.body?.updates)
    ? req.body.updates
    : null;

  if (!updates || !updates.length) {
    return res.status(400).json({
      ok: false,
      error: 'Provide at least one layout update',
    });
  }

  const applied = [];
  try {
    for (const entry of updates) {
      if (!entry) continue;
      const objectId =
        entry.object_id || entry.objectId || entry.id;
      if (!isValidObjectId(objectId)) continue;
      const layoutRow = await upsertLayoutRow(roadtripId, objectId, entry);
      if (layoutRow) {
        applied.push(layoutRow);
      }
    }
    if (!applied.length) {
      return res.status(400).json({
        ok: false,
        error: 'No valid layout updates applied',
      });
    }
    return res.json({
      ok: true,
      layouts: applied,
    });
  } catch (err) {
    console.error('[roadtrip] bulk layout update failed', err);
    return res.status(500).json({
      ok: false,
      error: 'Failed to apply layout updates',
    });
  }
});

router.get('/:roadtripId/live', async (req, res) => {
  const { roadtripId } = req.params || {};
  if (!roadtripId) {
    return res.status(400).json({
      ok: false,
      error: 'roadtripId param is required',
    });
  }
  const sessionPreference =
    req.query?.live_session || req.query?.session || null;
  try {
    const liveState = await loadRoadtripLiveState(
      roadtripId,
      sessionPreference
    );
    return res.json({
      ok: true,
      live_sessions: liveState.sessions,
      live_trace: liveState.trace,
      live_trace_session_id: liveState.trace_session_id,
    });
  } catch (err) {
    console.error('[roadtrip] failed to fetch live sessions', err);
    return res.status(500).json({
      ok: false,
      error: 'Unable to load live tracking data',
    });
  }
});
/**
 * POST /api/roadtrip/default
 * Upsert a per-user default roadtrip.
 *
 * Body (all optional unless noted):
 * {
 *   trip_vanity?: string,         // if omitted, becomes "<handle>-default-trip"
 *   name?: string,
 *   description?: string,
 *   party_id?: uuid | null,       // optional; if omitted we try NULL, then fallback to default party if needed
 *   starts_at?: timestamptz,
 *   ends_at?: timestamptz,
 *
 *   // only used if we must auto-create a default party:
 *   center_lat?: number,
 *   center_lon?: number,
 *   radius_m?: number
 * }
 */
// POST /api/roadtrips/default
router.post('/default', async (req, res) => {
  const body = req.body || {};
  const q = req.query || {};

  // 1) Identify member (use your existing identity if you have it)
  // If your plural routes currently accept ?member_id=... keep that here.
  const memberId = String(body.member_id || q.member_id || '').trim();
  if (!memberId) return res.status(400).json({ ok: false, error: 'member_id required' });

  // 2) Get handle for vanity naming (fallback to memberId)
  let handle = null;
  try {
    const r = await pool.query(`SELECT handle FROM ff_member WHERE member_id=$1 LIMIT 1`, [memberId]);
    handle = r.rows?.[0]?.handle ? String(r.rows[0].handle) : null;
  } catch (e) {
    console.warn('[roadtrips/default] handle lookup failed', e.message);
  }

  const base = slugifyTripName(handle || memberId) || 'trip';
  const tripVanity = `${base}-default-trip`;
  const tripName = `${base} default trip`;

  // 3) If exists, return it
  try {
    const ex = await pool.query(
      `SELECT * FROM tt_party_roadtrip WHERE trip_vanity IS NOT NULL AND lower(trip_vanity)=lower($1) LIMIT 1`,
      [tripVanity]
    );
    if (ex.rows.length) return res.json({ ok: true, created: false, roadtrip: ex.rows[0] });
  } catch (e) {
    console.error('[roadtrips/default] select existing failed', e);
    return res.status(500).json({ ok: false, error: 'select failed' });
  }

  // 4) Optional: allow caller to attach to party_id if you want
  let partyId = body.party_id || null;

  async function ensureDefaultPartyId() {
    const partyName = `${base}-default-party`;

    // reuse
    const existing = await pool.query(
      `SELECT party_id FROM tt_party WHERE host_member_id=$1 AND lower(name)=lower($2) ORDER BY created_at DESC LIMIT 1`,
      [memberId, partyName]
    );
    if (existing.rows.length) return existing.rows[0].party_id;

    // create (adjust columns to match your tt_party schema if needed)
    const created = await pool.query(
      `
      INSERT INTO tt_party (party_id, host_member_id, name, description, center_lat, center_lon, radius_m, party_type, host_handle)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, 0, 5000, 'private', $4)
      RETURNING party_id
      `,
      [memberId, partyName, 'Auto-created container party for default roadtrip', handle]
    );
    return created.rows[0].party_id;
  }

  async function insertRoadtrip(usePartyId) {
    return pool.query(
      `
      INSERT INTO tt_party_roadtrip (
        roadtrip_id, party_id, host_member_id, name, description, trip_vanity, state,
        planned_path, planned_distance_m, starts_at, ends_at
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'planning',
        NULL, NULL, NOW(), NULL
      )
      RETURNING *
      `,
      [usePartyId, memberId, tripName, null, tripVanity]
    );
  }

  // 5) Insert (try NULL party_id first; fallback if DB requires party_id)
  try {
    const ins = await insertRoadtrip(partyId);
    return res.status(201).json({ ok: true, created: true, roadtrip: ins.rows[0] });
  } catch (e) {
    const partyNotNull = !partyId && (e.code === '23502' || /party_id/i.test(String(e.message || '')));
    if (!partyNotNull) {
      console.error('[roadtrips/default] insert failed', e);
      return res.status(500).json({ ok: false, error: 'insert failed' });
    }

    try {
      const fallbackPartyId = await ensureDefaultPartyId();
      const ins2 = await insertRoadtrip(fallbackPartyId);
      return res.status(201).json({
        ok: true,
        created: true,
        default_party_id: fallbackPartyId,
        roadtrip: ins2.rows[0],
      });
    } catch (e2) {
      console.error('[roadtrips/default] fallback party insert failed', e2);
      return res.status(500).json({ ok: false, error: 'fallback insert failed' });
    }
  }
});


module.exports = router;

