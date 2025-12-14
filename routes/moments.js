// routes/moments.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { getCurrentIdentity } = require('../services/identity');
const { applyPrivacyToSharedCaptures } = require('../utils/privacyShare');

const router = express.Router();

router.use(express.json({ limit: '2mb', strict: false }));

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= 2000 ? trimmed : trimmed.slice(0, 2000);
}

function firstNonEmpty(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return null;
}

function createMomentId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `moment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeMomentRow(row) {
  if (!row) return null;
  return {
    id: row.moment_id || String(row.id),
    moment_id: row.moment_id,
    timestamp: isoDate(row.ts) || isoDate(row.created_at),
    member_id: row.member_id,
    handle: row.handle,
    owner_label: row.owner_label,
    source: row.source,
    share_public: row.share_public,
    lat: coerceNumber(row.lat),
    lon: coerceNumber(row.lon),
    speed_mps: coerceNumber(row.speed_mps),
    heading_deg: coerceNumber(row.heading_deg),
    accuracy_m: coerceNumber(row.accuracy_m),
    accel: {
      x: coerceNumber(row.accel_x),
      y: coerceNumber(row.accel_y),
      z: coerceNumber(row.accel_z),
    },
    text: row.text || '',
    photo_url: row.photo_url || null,
    photo_key: row.photo_key || null,
    video_url: row.video_url || null,
    video_key: row.video_key || null,
    media_meta: row.media_meta || null,
    extra: row.extra || null,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
  };
}

const ensureTablePromise = (async () => {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ff_moments (
      id BIGSERIAL PRIMARY KEY,
      moment_id UUID NOT NULL,
      member_id TEXT,
      handle TEXT,
      owner_label TEXT,
      source TEXT,
      share_public BOOLEAN DEFAULT FALSE,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      speed_mps DOUBLE PRECISION,
      heading_deg DOUBLE PRECISION,
      accuracy_m DOUBLE PRECISION,
      accel_x DOUBLE PRECISION,
      accel_y DOUBLE PRECISION,
      accel_z DOUBLE PRECISION,
      text TEXT,
      photo_url TEXT,
      photo_key TEXT,
      video_url TEXT,
      video_key TEXT,
      media_meta JSONB,
      extra JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ff_moments_moment_id_idx ON ff_moments(moment_id);
    CREATE INDEX IF NOT EXISTS ff_moments_ts_idx ON ff_moments(ts DESC);
    CREATE INDEX IF NOT EXISTS ff_moments_handle_idx ON ff_moments((LOWER(handle)));
    CREATE INDEX IF NOT EXISTS ff_moments_member_idx ON ff_moments(member_id, ts DESC);
  `;

  try {
    await pool.query(ddl);
    console.log('[moments] table ready');
  } catch (err) {
    console.error('[moments] failed to ensure table', err);
    throw err;
  }
})();

async function ensureReady() {
  return ensureTablePromise.catch((err) => {
    console.error('[moments] ensureReady error', err);
    throw err;
  });
}

router.get('/', async (req, res) => {
  try {
    await ensureReady();

    const params = [];
    const where = [];

    if (req.query.handle) {
      params.push(String(req.query.handle).trim().toLowerCase());
      where.push(`LOWER(handle) = $${params.length}`);
    }

    if (req.query.member_id) {
      params.push(String(req.query.member_id).trim());
      where.push(`member_id = $${params.length}`);
    }

    const publicOnly = String(req.query.public_only || req.query.publicOnly || '').toLowerCase();
    if (publicOnly === 'true' || publicOnly === '1') {
      where.push('share_public = true');
    }

    const after = req.query.after || req.query.since;
    if (after) {
      const d = new Date(after);
      if (!Number.isNaN(d.getTime())) {
        params.push(d.toISOString());
        where.push(`ts >= $${params.length}`);
      }
    }

    const before = req.query.before || req.query.until;
    if (before) {
      const d = new Date(before);
      if (!Number.isNaN(d.getTime())) {
        params.push(d.toISOString());
        where.push(`ts <= $${params.length}`);
      }
    }

    if (req.query.cursor) {
      const d = new Date(req.query.cursor);
      if (!Number.isNaN(d.getTime())) {
        params.push(d.toISOString());
        where.push(`ts < $${params.length}`);
      }
    }

    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;
    params.push(limit);

    const { rows } = await pool.query(
      `
        SELECT id, moment_id, member_id, handle, owner_label, source, share_public,
               ts, lat, lon, speed_mps, heading_deg, accuracy_m,
               accel_x, accel_y, accel_z,
               text, photo_url, photo_key, video_url, video_key,
               media_meta, extra, created_at, updated_at
          FROM ff_moments
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ts DESC, id DESC
         LIMIT $${params.length}
      `,
      params,
    );

    const moments = rows.map(normalizeMomentRow);
    const identity = await getCurrentIdentity(req).catch(() => null);
    const viewerMemberId = identity?.memberId || identity?.member_id || null;
    const capturesByOwner = new Map();
    for (const moment of moments) {
      const ownerId = moment.member_id || moment.memberId || null;
      if (!ownerId) {
        continue;
      }
      if (!capturesByOwner.has(ownerId)) {
        capturesByOwner.set(ownerId, []);
      }
      capturesByOwner.get(ownerId).push(moment);
    }
    for (const [ownerId, ownerCaptures] of capturesByOwner.entries()) {
      await applyPrivacyToSharedCaptures({
        viewerMemberId,
        ownerMemberId: ownerId,
        captures: ownerCaptures,
        db: pool,
      });
    }
    const nextCursor =
      moments.length === limit ? moments[moments.length - 1]?.timestamp || null : null;

    res.json({
      ok: true,
      count: moments.length,
      moments,
      next_cursor: nextCursor,
    });
  } catch (err) {
    console.error('[moments.list] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/:momentId', async (req, res) => {
  try {
    await ensureReady();
    const idParam = String(req.params.momentId || '').trim();
    if (!idParam) {
      return res.status(400).json({ ok: false, error: 'missing_id' });
    }

    let where;
    let params;
    if (isUuid(idParam)) {
      where = 'moment_id = $1';
      params = [idParam];
    } else if (/^\d+$/.test(idParam)) {
      where = 'id = $1';
      params = [Number(idParam)];
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }

    const { rows } = await pool.query(
      `
        SELECT id, moment_id, member_id, handle, owner_label, source, share_public,
               ts, lat, lon, speed_mps, heading_deg, accuracy_m,
               accel_x, accel_y, accel_z,
               text, photo_url, photo_key, video_url, video_key,
               media_meta, extra, created_at, updated_at
          FROM ff_moments
         WHERE ${where}
         LIMIT 1
      `,
      params,
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({ ok: true, moment: normalizeMomentRow(row) });
  } catch (err) {
    console.error('[moments.detail] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/', async (req, res) => {
  try {
    await ensureReady();
    const payload = req.body || {};
    const timestamp = payload.timestamp || payload.ts || payload.created_at || new Date().toISOString();
    const ts = new Date(timestamp);
    if (Number.isNaN(ts.getTime())) {
      return res.status(422).json({ ok: false, error: 'invalid_timestamp' });
    }

    const providedMomentId = firstNonEmpty(payload.moment_id, payload.momentId, payload.id);
    const momentId = isUuid(providedMomentId) ? providedMomentId : createMomentId();

    const memberId = firstNonEmpty(payload.member_id, payload.memberId);
    const handleOriginal = firstNonEmpty(payload.handle, payload.ownerHandle, payload.owner_handle);
    const handle = handleOriginal ? handleOriginal.toLowerCase() : null;
    const ownerLabel = firstNonEmpty(payload.owner_label, payload.ownerLabel, handleOriginal, memberId);
    const source = firstNonEmpty(payload.source, payload.client, 'app');
    const sharePublic = Boolean(
      payload.share_public ?? payload.sharePublic ?? payload.public ?? false,
    );

    const coords = payload.coords || payload.location || {};
    const lat = coerceNumber(payload.lat ?? coords.lat ?? coords.latitude);
    const lon = coerceNumber(payload.lon ?? coords.lon ?? coords.longitude);
    const speed = coerceNumber(payload.speed_mps ?? payload.speedMps ?? coords.speed);
    const heading = coerceNumber(payload.heading_deg ?? payload.headingDeg ?? coords.heading);
    const accuracy = coerceNumber(payload.accuracy_m ?? payload.accuracy ?? coords.accuracy);
    const accel = payload.accel || payload.acceleration || {};

    const text = sanitizeText(payload.text || payload.caption || '');

    const media = Array.isArray(payload.media)
      ? payload.media
      : payload.media
        ? [payload.media]
        : [];
    const primaryMedia = media.find((entry) => entry && (entry.kind || entry.public_url || entry.url)) || null;
    const mediaKind = primaryMedia?.kind
      ? String(primaryMedia.kind).toLowerCase()
      : primaryMedia?.content_type && primaryMedia.content_type.toLowerCase().startsWith('video')
        ? 'video'
        : 'photo';

    const photoUrl =
      firstNonEmpty(
        payload.photo_url,
        payload.photoUri,
        mediaKind === 'photo' ? primaryMedia?.public_url : null,
        mediaKind === 'photo' ? primaryMedia?.url : null,
      ) || null;
    const videoUrl =
      firstNonEmpty(
        payload.video_url,
        payload.videoUri,
        mediaKind === 'video' ? primaryMedia?.public_url : null,
        mediaKind === 'video' ? primaryMedia?.url : null,
      ) || null;
    const photoKey =
      firstNonEmpty(
        payload.photo_key,
        mediaKind === 'photo' ? primaryMedia?.key : null,
        mediaKind === 'photo' ? primaryMedia?.r2_key : null,
      ) || null;
    const videoKey =
      firstNonEmpty(
        payload.video_key,
        mediaKind === 'video' ? primaryMedia?.key : null,
        mediaKind === 'video' ? primaryMedia?.r2_key : null,
      ) || null;

    const mediaMeta =
      primaryMedia && Object.keys(primaryMedia).length ? primaryMedia : null;
    const extra = payload.extra || payload.metadata || null;

    const insertSql = `
      INSERT INTO ff_moments (
        moment_id, member_id, handle, owner_label, source, share_public,
        ts, lat, lon, speed_mps, heading_deg, accuracy_m,
        accel_x, accel_y, accel_z,
        text, photo_url, photo_key, video_url, video_key,
        media_meta, extra, created_at, updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,
        $13,$14,$15,
        $16,$17,$18,$19,$20,
        $21,$22, now(), now()
      )
      ON CONFLICT (moment_id) DO UPDATE SET
        member_id = EXCLUDED.member_id,
        handle = EXCLUDED.handle,
        owner_label = EXCLUDED.owner_label,
        source = EXCLUDED.source,
        share_public = EXCLUDED.share_public,
        ts = EXCLUDED.ts,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        speed_mps = EXCLUDED.speed_mps,
        heading_deg = EXCLUDED.heading_deg,
        accuracy_m = EXCLUDED.accuracy_m,
        accel_x = EXCLUDED.accel_x,
        accel_y = EXCLUDED.accel_y,
        accel_z = EXCLUDED.accel_z,
        text = EXCLUDED.text,
        photo_url = EXCLUDED.photo_url,
        photo_key = EXCLUDED.photo_key,
        video_url = EXCLUDED.video_url,
        video_key = EXCLUDED.video_key,
        media_meta = EXCLUDED.media_meta,
        extra = EXCLUDED.extra,
        updated_at = now()
      RETURNING id, moment_id, member_id, handle, owner_label, source, share_public,
                ts, lat, lon, speed_mps, heading_deg, accuracy_m,
                accel_x, accel_y, accel_z,
                text, photo_url, photo_key, video_url, video_key,
                media_meta, extra, created_at, updated_at
    `;

    const params = [
      momentId,
      memberId,
      handle,
      ownerLabel,
      source,
      sharePublic,
      ts.toISOString(),
      lat,
      lon,
      speed,
      heading,
      accuracy,
      coerceNumber(accel.x),
      coerceNumber(accel.y),
      coerceNumber(accel.z),
      text,
      photoUrl,
      photoKey,
      videoUrl,
      videoKey,
      mediaMeta,
      extra,
    ];

    const { rows } = await pool.query(insertSql, params);
    const saved = rows[0];

    return res.status(201).json({
      ok: true,
      moment: normalizeMomentRow(saved),
    });
  } catch (err) {
    console.error('[moments.insert] error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
