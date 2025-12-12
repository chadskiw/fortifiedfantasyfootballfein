// routes/soundtrack.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');

const router = express.Router();

router.use(express.json({ limit: '4mb', strict: false }));

const SHARE_HOST = (process.env.SOUNDTRACK_SHARE_HOST || 'https://soundtrack-share.pages.dev').replace(
  /\/+$/,
  '',
);

const ensureTablesPromise = (async () => {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ff_soundtrack_shares (
      share_id TEXT PRIMARY KEY,
      member_id TEXT,
      handle TEXT,
      scope TEXT,
      day_key TEXT,
      trip_range JSONB,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS ff_soundtrack_shares_member_idx ON ff_soundtrack_shares(member_id);
    CREATE INDEX IF NOT EXISTS ff_soundtrack_shares_handle_idx ON ff_soundtrack_shares((LOWER(handle)));
    CREATE INDEX IF NOT EXISTS ff_soundtrack_shares_scope_idx ON ff_soundtrack_shares(scope);
  `;

  try {
    await pool.query(ddl);
    console.log('[soundtrack] tables ensured');
  } catch (err) {
    console.error('[soundtrack] failed to ensure tables', err);
    throw err;
  }
})();

async function ensureReady() {
  return ensureTablesPromise.catch((err) => {
    console.error('[soundtrack] ensureReady error', err);
    throw err;
  });
}

function sanitizeText(value, max = 500) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function sanitizeToken(value, { lower = false } = {}) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return lower ? cleaned.toLowerCase() : cleaned;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function dateOnly(value) {
  const iso = isoDate(value);
  return iso ? iso.split('T')[0] : null;
}

function normalizeScope(value) {
  const normalized = String(value || '').toLowerCase();
  if (['day', 'trip', 'life'].includes(normalized)) return normalized;
  return 'day';
}

function buildShareId({ memberId, handle, scope }) {
  const base = sanitizeToken(handle || memberId || 'soundtrack');
  const scopeToken = sanitizeToken(scope || 'mix', { lower: true }) || 'mix';
  if (typeof crypto.randomUUID === 'function') {
    return `${base || 'soundtrack'}-${scopeToken}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${base || 'soundtrack'}-${scopeToken}-${Date.now().toString(36)}`;
}

function resolveShareId(raw, fallbackMeta) {
  const candidate = sanitizeToken(raw || '', { lower: false });
  if (candidate) return candidate;
  return buildShareId(fallbackMeta);
}

function deriveScopeDescriptor(scope, dayKey, tripRange) {
  if (scope === 'day' && dayKey) {
    return `Day ${dayKey}`;
  }
  if (scope === 'trip' && tripRange?.start && tripRange?.end) {
    return `${tripRange.start} → ${tripRange.end}`;
  }
  return 'Life mix';
}

function formatCaptureTime(value) {
  const iso = isoDate(value);
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadMoments(mediaIds) {
  if (!mediaIds.length) return new Map();
  const { rows } = await pool.query(
    `
      SELECT moment_id::text AS moment_id,
             ts,
             owner_label,
             text,
             source,
             handle,
             photo_url,
             video_url,
             media_meta
        FROM ff_moments
       WHERE moment_id::text = ANY($1)
    `,
    [mediaIds],
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.moment_id, row);
  }
  return map;
}

function sanitizeAudioSource(src) {
  if (!src || typeof src !== 'object') return null;
  const result = {};
  if (typeof src.type === 'string') result.type = src.type;
  if (typeof src.url === 'string') result.url = src.url;
  if (typeof src.name === 'string') result.name = sanitizeText(src.name, 200);
  if (src.trim && typeof src.trim === 'object') {
    const trim = {};
    if (Number.isFinite(src.trim.start_seconds)) trim.start_seconds = Number(src.trim.start_seconds);
    if (Number.isFinite(src.trim.end_seconds)) trim.end_seconds = Number(src.trim.end_seconds);
    if (Number.isFinite(src.trim.duration_seconds)) trim.duration_seconds = Number(src.trim.duration_seconds);
    if (Object.keys(trim).length) result.trim = trim;
  }
  return Object.keys(result).length ? result : null;
}

router.get('/share', async (req, res) => {
  const shareId = sanitizeToken(req.query.id || req.query.share_id || '', { lower: false });
  if (!shareId) {
    return res.status(400).json({ ok: false, error: 'missing_share_id' });
  }

  try {
    await ensureReady();
    const { rows } = await pool.query(
      `
        SELECT share_id, payload
          FROM ff_soundtrack_shares
         WHERE share_id = $1
      `,
      [shareId],
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const payload = rows[0].payload || {};
    if (SHARE_HOST && !payload.share_url) {
      payload.share_url = `${SHARE_HOST}/s/${encodeURIComponent(rows[0].share_id)}`;
    }
    return res.json({ ok: true, share: payload });
  } catch (err) {
    console.error('[soundtrack] GET /share error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/share', async (req, res) => {
  const body = req.body || {};
  const memberId = sanitizeText(body.member_id || body.memberId || '', 120) || null;
  const handleRaw = sanitizeText(body.handle || body.user_handle || '', 120);
  const handle = handleRaw || null;
  const scope = normalizeScope(body.scope);
  const dayKey = dateOnly(body.day_key || body.dayKey);
  const tripRangeRaw = body.trip_range || body.tripRange || null;
  const tripRange = tripRangeRaw
    ? {
        start: dateOnly(tripRangeRaw.start),
        end: dateOnly(tripRangeRaw.end),
      }
    : null;
  const mediaIds = Array.isArray(body.media_ids)
    ? body.media_ids
        .map((value) => String(value || '').trim())
        .filter((value) => Boolean(value))
    : [];
  if (!mediaIds.length) {
    return res.status(400).json({ ok: false, error: 'media_required' });
  }

  const mediaSourcesMap = new Map();
  if (Array.isArray(body.media_sources)) {
    for (const item of body.media_sources) {
      if (item && item.id) {
        mediaSourcesMap.set(String(item.id), item);
      }
    }
  }

  const shareId = resolveShareId(body.share_id || body.id, {
    memberId: memberId || handle || 'soundtrack',
    handle,
    scope,
  });

  const shareIdProvided = Boolean(body.share_id || body.id);

  try {
    await ensureReady();
    let preservedCreatedAt = null;
    if (shareIdProvided) {
      try {
        const existing = await pool.query(
          `SELECT payload->>'created_at' AS created_at FROM ff_soundtrack_shares WHERE share_id = $1`,
          [shareId],
        );
        preservedCreatedAt = existing.rows[0]?.created_at || null;
      } catch (err) {
        console.warn('[soundtrack] prefetch share created_at failed', err);
      }
    }
    const momentMap = await loadMoments(mediaIds);
    const captures = [];
    const missing = [];

    for (const id of mediaIds) {
      const row = momentMap.get(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      const mediaUrl = row.video_url || row.photo_url;
      if (!mediaUrl) {
        missing.push(id);
        continue;
      }
      const metaSource = mediaSourcesMap.get(id);
      const mediaMeta = row.media_meta || {};
      captures.push({
        id,
        url: mediaUrl,
        type: row.video_url ? 'video' : 'photo',
        timestamp: isoDate(row.ts),
        label: row.owner_label || row.text || null,
        handle: row.handle || handle || null,
        source: metaSource?.source || row.source || null,
        media_meta: mediaMeta || null,
        thumbnail_url:
          metaSource?.thumbnail_url || mediaMeta?.thumbnail_url || (!row.video_url ? row.photo_url : null) || null,
        taken_at_formatted: formatCaptureTime(row.ts),
      });
    }

    if (!captures.length) {
      return res.status(422).json({ ok: false, error: 'media_unavailable', missing_media_ids: missing });
    }

    const audioSource = sanitizeAudioSource(body.audio_source || body.audioSource);
    const audioTrim = body.audio_trim && typeof body.audio_trim === 'object' ? body.audio_trim : audioSource?.trim || null;
    const audioUrl = audioSource?.url || null;
    const descriptor = deriveScopeDescriptor(scope, dayKey, tripRange);
    const title =
      sanitizeText(body.title, 240) ||
      (handle ? `Soundtrack of @${handle}` : memberId ? `Soundtrack for ${memberId}` : 'Soundtrack Of My Day');
    const description =
      sanitizeText(body.description, 500) || `${descriptor}${memberId ? ` • ${memberId}` : ''}`.trim();
    const coverUrl =
      sanitizeText(body.cover_url || body.coverUrl || '', 2000) ||
      captures[0].thumbnail_url ||
      captures[0].url ||
      null;
    const nowIso = new Date().toISOString();
    const createdAtIso = preservedCreatedAt || nowIso;
    const shareUrl = `${SHARE_HOST}/s/${encodeURIComponent(shareId)}`;

    const sharePayload = {
      id: shareId,
      member_id: memberId,
      handle,
      scope,
      day_key: dayKey,
      trip_range: tripRange,
      title,
      description,
      cover_url: coverUrl,
      audio_url: audioUrl,
      audio_source: audioSource,
      audio_trim: audioTrim,
      captures,
      media_count: captures.length,
      missing_media_ids: missing,
      share_url: shareUrl,
      created_at: createdAtIso,
      updated_at: nowIso,
    };

    const { rows } = await pool.query(
      `
        INSERT INTO ff_soundtrack_shares (share_id, member_id, handle, scope, day_key, trip_range, payload, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now())
        ON CONFLICT (share_id)
        DO UPDATE SET
          member_id = EXCLUDED.member_id,
          handle = EXCLUDED.handle,
          scope = EXCLUDED.scope,
          day_key = EXCLUDED.day_key,
          trip_range = EXCLUDED.trip_range,
          payload = EXCLUDED.payload,
          updated_at = now()
        RETURNING payload
      `,
      [shareId, memberId, handle, scope, dayKey, tripRange ? JSON.stringify(tripRange) : null, JSON.stringify(sharePayload)],
    );

    const saved = rows[0]?.payload || sharePayload;
    return res.json({
      ok: true,
      share_id: shareId,
      share_url: shareUrl,
      share: saved,
    });
  } catch (err) {
    console.error('[soundtrack] POST /share error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
