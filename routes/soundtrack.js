// routes/soundtrack.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { buildMuSongMapFromQueue } = require('../utils/muMapping');

const router = express.Router();
router.use(express.json({ limit: '4mb', strict: false }));

const SHARE_HOST = (process.env.SOUNDTRACK_SHARE_HOST || 'https://soundtrack-share.pages.dev').replace(/\/+$/, '');

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
  await pool.query(ddl);
  console.log('[soundtrack] tables ensured');
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
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
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

function normalizePlaybackMode(value) {
  return String(value || '').toLowerCase() === 'mu' ? 'mu' : 'classic';
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
  return candidate || buildShareId(fallbackMeta);
}

function deriveScopeDescriptor(scope, dayKey, tripRange) {
  if (scope === 'day' && dayKey) return `Day ${dayKey}`;
  if (scope === 'trip' && tripRange?.start && tripRange?.end) return `${tripRange.start} → ${tripRange.end}`;
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
  for (const row of rows) map.set(row.moment_id, row);
  return map;
}

function clamp01(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeClipRange(range = {}) {
  if (!range || typeof range !== 'object') return { start: 0, end: 1 };
  const start = clamp01(range.start);
  const end = clamp01(range.end);
  if (end <= start) return { start: 0, end: 1 };
  return { start, end };
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function normalizeAudioTrim(trim = null) {
  if (!trim || typeof trim !== 'object') return null;
  const startMs = toInt(trim.start_ms ?? trim.startMs);
  const endMs = toInt(trim.end_ms ?? trim.endMs);
  const durationMs = toInt(trim.duration_ms ?? trim.durationMs);

  const startSeconds = Number.isFinite(Number(trim.start_seconds)) ? Number(trim.start_seconds) : null;
  const endSeconds = Number.isFinite(Number(trim.end_seconds)) ? Number(trim.end_seconds) : null;
  const durationSeconds = Number.isFinite(Number(trim.duration_seconds)) ? Number(trim.duration_seconds) : null;

  return {
    start_ms: startMs ?? null,
    end_ms: endMs ?? null,
    duration_ms:
      durationMs ??
      (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null),
    start_seconds: startSeconds,
    end_seconds: endSeconds,
    duration_seconds: durationSeconds,
    start_pct: clamp01(trim.start_pct),
    end_pct: clamp01(trim.end_pct),
  };
}

function sanitizeAudioSource(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {
    kind: src.kind || src.type || null,
    title: src.title || src.name || null,
    artist: src.artist || null,
    album: src.album || null,
    url: src.url || null,
    stream_url: src.stream_url || src.streamUrl || null,
    track_id: src.track_id || src.trackId || null,
    art_url: src.art_url || src.artUrl || null,
    duration_seconds: src.duration_seconds ?? src.durationSeconds ?? null,
    source: src.source || null,
  };
  // keep optional trim if present
  if (src.trim && typeof src.trim === 'object') out.trim = src.trim;
  // remove all-null objects
  const hasAny = Object.values(out).some((v) => v !== null && typeof v !== 'undefined');
  return hasAny ? out : null;
}

function sanitizeAudioQueue(queue) {
  if (!Array.isArray(queue)) return null;
  const cleaned = queue
    .filter(Boolean)
    .slice(0, 500)
    .map((t, idx) => {
      if (!t || typeof t !== 'object') return null;
      const duration = Number(t.duration_seconds ?? t.durationSeconds);
      return {
        index: typeof t.index === 'number' ? t.index : idx,
        id: t.id || null,
        track_id: t.track_id || t.trackId || null,
        title: t.title || t.name || null,
        artist: t.artist || null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
      };
    })
    .filter((t) => t && Number.isFinite(Number(t.duration_seconds)) && Number(t.duration_seconds) > 0);

  return cleaned.length ? cleaned : null;
}

function normalizeMu(mu) {
  if (!mu || typeof mu !== 'object') return null;

  // accept cuts_ms or cutsMs
  const rawCuts = Array.isArray(mu.cuts_ms) ? mu.cuts_ms : Array.isArray(mu.cutsMs) ? mu.cutsMs : null;
  const cuts = rawCuts
    ? rawCuts
        .map((v) => toInt(v))
        .filter((v) => typeof v === 'number' && v >= 0)
        .sort((a, b) => a - b)
    : [];

  if (!cuts.length) return null;
  if (cuts[0] !== 0) cuts.unshift(0);

  // dedupe
  const deduped = cuts.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

  const songs = Array.isArray(mu.songs)
    ? mu.songs
        .map((s, index) => {
          if (!s) return null;
          const start = toInt(s.start_ms ?? s.startMs);
          const end = toInt(s.end_ms ?? s.endMs);
          if (start === null || end === null || end <= start) return null;
          return {
            index,
            title: s.title || null,
            artist: s.artist || null,
            start_ms: start,
            end_ms: end,
            duration_ms: end - start,
          };
        })
        .filter(Boolean)
    : undefined;

  return {
    cuts_ms: deduped,
    songs,
    total_ms: toInt(mu.total_ms ?? mu.totalMs),
    transition_ms: toInt(mu.transition_ms ?? mu.transitionMs) ?? 250,
    strategy: typeof mu.strategy === 'string' ? mu.strategy : undefined,
  };
}

function normalizeMuSegments(segments) {
  if (!Array.isArray(segments)) return null;
  const mapped = segments
    .map((seg) => {
      if (!seg) return null;
      const start = toInt(seg.start_ms ?? seg.startMs);
      const end = toInt(seg.end_ms ?? seg.endMs);
      if (start === null || end === null || end <= start) return null;
      return {
        index: typeof seg.index === 'number' ? seg.index : null,
        start_ms: start,
        end_ms: end,
        duration_ms: end - start,
        capture_index: seg.capture_index ?? seg.captureIndex ?? null,
      };
    })
    .filter(Boolean);
  return mapped.length ? mapped : null;
}

function buildMuSegmentsFromCuts(mu, captureCount) {
  if (!mu?.cuts_ms?.length || captureCount <= 0) return null;
  const cuts = mu.cuts_ms;
  const segs = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end <= start) continue;
    segs.push({
      index: i,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      capture_index: i % captureCount,
    });
  }
  return segs.length ? segs : null;
}

// GET /api/soundtrack/share?id=...
router.get('/share', async (req, res) => {
  const shareId = sanitizeToken(req.query.id || req.query.share_id || '', { lower: false });
  if (!shareId) return res.status(400).json({ ok: false, error: 'missing_share_id' });

  try {
    await ensureReady();
    const { rows } = await pool.query(
      `SELECT share_id, payload FROM ff_soundtrack_shares WHERE share_id = $1`,
      [shareId],
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });

    const payload = rows[0].payload || {};
    if (SHARE_HOST && !payload.share_url) payload.share_url = `${SHARE_HOST}/s/${encodeURIComponent(rows[0].share_id)}`;

    // keep mu_available consistent even for older rows
    if (typeof payload.mu_available !== 'boolean') {
      payload.mu_available = Boolean(payload?.mu?.cuts_ms?.length || payload?.mu_mapping?.cuts_ms?.length);
    }

    return res.json({ ok: true, share: payload });
  } catch (err) {
    console.error('[soundtrack] GET /share error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/soundtrack/share
router.post('/share', async (req, res) => {
  const body = req.body || {};
  const memberId = sanitizeText(body.member_id || body.memberId || '', 120) || null;
  const handleRaw = sanitizeText(body.handle || body.user_handle || '', 120);
  const handle = handleRaw || null;

  const scope = normalizeScope(body.scope);
  const dayKey = dateOnly(body.day_key || body.dayKey);
  const tripRangeRaw = body.trip_range || body.tripRange || null;
  const tripRange = tripRangeRaw
    ? { start: dateOnly(tripRangeRaw.start), end: dateOnly(tripRangeRaw.end) }
    : null;

  const playbackModeRequested = normalizePlaybackMode(body.playback_mode || body.playbackMode);
  const clipRange = normalizeClipRange(body.clip_range || body.clipRange);

  const mediaIds = Array.isArray(body.media_ids)
    ? body.media_ids.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  if (!mediaIds.length) return res.status(400).json({ ok: false, error: 'media_required' });

  const mediaSourcesMap = new Map();
  if (Array.isArray(body.media_sources)) {
    for (const item of body.media_sources) {
      if (item && item.id) mediaSourcesMap.set(String(item.id), item);
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

    // preserve created_at if overwriting an existing share_id
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
          metaSource?.thumbnail_url ||
          mediaMeta?.thumbnail_url ||
          (!row.video_url ? row.photo_url : null) ||
          null,
        taken_at_formatted: formatCaptureTime(row.ts),
      });
    }

    if (!captures.length) {
      return res.status(422).json({ ok: false, error: 'media_unavailable', missing_media_ids: missing });
    }

    const audioSource = sanitizeAudioSource(body.audio_source || body.audioSource);
    const audioTrim = normalizeAudioTrim(body.audio_trim || body.audioTrim || audioSource?.trim || null);
    const audioQueue = sanitizeAudioQueue(body.audio_queue || body.audioQueue);

    // mu can be provided OR computed from queue+trim
    let mu = normalizeMu(body.mu || body.mu_mapping || body.muMapping);
    if (!mu && audioQueue?.length) {
      mu = normalizeMu({ ...buildMuSongMapFromQueue(audioQueue, audioTrim), strategy: 'queue' });
    }

    let muSegments =
      normalizeMuSegments(body.mu_segments || body.muSegments) ||
      (mu ? buildMuSegmentsFromCuts(mu, captures.length) : null);

    const muAvailable = Boolean(mu?.cuts_ms?.length);
    const playbackModeEffective = playbackModeRequested === 'mu' && muAvailable ? 'mu' : 'classic';

    const audioUrl = audioSource?.stream_url || audioSource?.url || null;

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
      // ids
      id: shareId,
      share_id: shareId,
      member_id: memberId,
      handle,
      scope,
      day_key: dayKey,
      trip_range: tripRange,

      // playback
      playback_mode: playbackModeRequested,
      playback_mode_effective: playbackModeEffective,
      clip_range: clipRange,

      // audio
      audio_url: audioUrl,
      audio_source: audioSource,
      audio_trim: audioTrim,
      audio_queue: audioQueue || undefined,

      // mu mode
      mu: mu || null,
      mu_mapping: mu || null, // backward-compat alias
      mu_segments: muSegments || undefined,
      mu_available: muAvailable,

      // media
      title,
      description,
      cover_url: coverUrl,
      captures,
      media_count: captures.length,
      missing_media_ids: missing,

      // links + timestamps
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
      [
        shareId,
        memberId,
        handle,
        scope,
        dayKey,
        tripRange ? JSON.stringify(tripRange) : null,
        JSON.stringify(sharePayload),
      ],
    );

    const saved = rows[0]?.payload || sharePayload;
    return res.json({ ok: true, share_id: shareId, share_url: shareUrl, share: saved });
  } catch (err) {
    console.error('[soundtrack] POST /share error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
