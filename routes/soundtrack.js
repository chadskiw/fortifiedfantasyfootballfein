// soundtrack.js
const { randomUUID } = require('crypto');

const DEFAULT_SHARE_HOST = process.env.SOUNDTRACK_SHARE_HOST || 'https://soundtrack-share.pages.dev';

// NOTE: In-memory store. Good for dev / demo. Not persistent across restarts.
const shareStore = new Map();
const MAX_SHARES_IN_MEMORY = 2000;

function registerSoundtrackRoutes(app) {
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') {
    throw new Error('Soundtrack routes require an Express-style app instance.');
  }

  // Create / upsert a share payload
  app.post('/api/soundtrack/share', async (req, res) => {
    try {
      const payload = buildSharePayload(req?.body || {});
      shareStore.set(payload.share_id, payload);
      pruneStore();

      res.json({
        ok: true,
        share_id: payload.share_id,
        share_url: payload.share_url,
        share: payload,
      });
    } catch (err) {
      console.warn('[soundtrack-share] failed to build payload', err);
      res.status(400).json({ ok: false, error: err?.message || 'share_failed' });
    }
  });

  // Read share by query (?id= or ?share_id=) — matches your current callers
  app.get('/api/soundtrack/share', (req, res) => {
    const shareId = sanitizeToken(req.query?.id || req.query?.share_id || '');
    if (!shareId || !shareStore.has(shareId)) {
      res.status(404).json({ ok: false, error: 'share_not_found' });
      return;
    }
    res.json({ ok: true, share: shareStore.get(shareId) });
  });

  // Read share by path (/api/soundtrack/share/:id)
  app.get('/api/soundtrack/share/:id', (req, res) => {
    const shareId = sanitizeToken(req.params?.id || '');
    if (!shareId || !shareStore.has(shareId)) {
      res.status(404).json({ ok: false, error: 'share_not_found' });
      return;
    }
    res.json({ ok: true, share: shareStore.get(shareId) });
  });
}

function buildSharePayload(body = {}) {
  const now = new Date().toISOString();
  const shareId = sanitizeToken(body.share_id) || createShareId();

  const captures = normalizeCaptures(body.captures);
  if (!captures.length) {
    throw new Error('missing_captures');
  }

  const mediaIds = normalizeMediaIds(body.media_ids, captures);
  const clipRange = normalizeClipRange(body.clip_range);
  const audioTrim = normalizeAudioTrim(body.audio_trim);
  const audioSource = normalizeAudioSource(body.audio_source);

  const playbackMode = normalizePlaybackMode(body.playback_mode || body.playbackMode);
  const playbackModeEffective = normalizePlaybackMode(body.playback_mode_effective || body.playbackModeEffective || playbackMode);

  const mu = normalizeMu(body.mu);
  const muSegments = normalizeMuSegments(body.mu_segments);

  const audioQueue = Array.isArray(body.audio_queue) ? body.audio_queue : undefined;

  const payload = {
    share_id: shareId,
    member_id: sanitizeText(body.member_id, 120) || null,
    handle: sanitizeHandle(body.handle),
    scope: sanitizeScope(body.scope),
    scope_meta: buildScopeMeta(body.scope_meta),

    playback_mode: playbackMode,
    playback_mode_effective: playbackModeEffective,

    media_ids: mediaIds,
    captures,

    clip_range: clipRange,
    audio_trim: audioTrim,
    audio_source: audioSource,

    audio_queue: audioQueue,
    mu,
    mu_segments: muSegments,

    mu_available: Boolean(mu?.cuts_ms?.length),

    client: sanitizeText(body.client, 80) || 'unknown',
    share_url: buildShareUrl(shareId, body.share_host),

    created_at: body.created_at || now,
    updated_at: now,
  };

  return payload;
}

function normalizePlaybackMode(mode) {
  return mode === 'mu' ? 'mu' : 'classic';
}

function sanitizeHandle(handle) {
  if (!handle) return null;
  const trimmed = String(handle).trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

function sanitizeScope(scope) {
  if (scope === 'trip' || scope === 'life') return scope;
  return 'day';
}

function buildScopeMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};
  const captureCount = toInt(meta.capture_count);
  return {
    descriptor: meta.descriptor || null,
    selected_day: meta.selected_day || null,
    trip_range: meta.trip_range || null,
    capture_count: captureCount !== null ? captureCount : null,
  };
}

function normalizeMediaIds(mediaIds, captures) {
  if (Array.isArray(mediaIds) && mediaIds.length) {
    return mediaIds.map((value) => String(value));
  }
  return captures.map((capture) => capture.id).filter(Boolean);
}

function normalizeCaptures(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((item, idx) => {
      if (!item) return null;

      const url =
        item.url ||
        item.uri ||
        item.photo_url ||
        item.video_url ||
        item.thumbnail_url ||
        null;

      if (!url) return null;

      const type = item.type === 'video' || item.video_url ? 'video' : 'photo';

      return {
        id: item.id ? String(item.id) : `capture-${idx}`,
        url,
        uri: url,
        type,
        timestamp: item.timestamp || null,
        label: item.label || null,
        ordinal: typeof item.ordinal === 'number' ? item.ordinal : idx + 1,
        thumbnail_url: item.thumbnail_url || item.thumbnail || null,
      };
    })
    .filter(Boolean);
}

function normalizeClipRange(range = {}) {
  if (!range || typeof range !== 'object') return { start: 0, end: 1 };
  const start = clamp01(range.start);
  const end = clamp01(range.end);
  if (end <= start) return { start: 0, end: 1 };
  return { start, end };
}

function normalizeAudioTrim(trim = {}) {
  if (!trim || typeof trim !== 'object') return { start_ms: null, end_ms: null, duration_ms: null, start_pct: 0, end_pct: 0 };

  // Accept either ms or seconds input (your app often has seconds)
  const startMs =
    toInt(trim.start_ms ?? trim.startMs) ??
    (Number.isFinite(Number(trim.start_seconds)) ? Math.round(Number(trim.start_seconds) * 1000) : null);

  const endMs =
    toInt(trim.end_ms ?? trim.endMs) ??
    (Number.isFinite(Number(trim.end_seconds)) ? Math.round(Number(trim.end_seconds) * 1000) : null);

  const durationMs =
    toInt(trim.duration_ms ?? trim.durationMs) ??
    (Number.isFinite(Number(trim.duration_seconds)) ? Math.round(Number(trim.duration_seconds) * 1000) : null) ??
    (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null);

  return {
    start_ms: startMs ?? null,
    end_ms: endMs ?? null,
    duration_ms: durationMs ?? null,
    start_pct: clamp01(trim.start_pct),
    end_pct: clamp01(trim.end_pct),
  };
}

function normalizeAudioSource(source) {
  if (!source || typeof source !== 'object') return null;

  // Accept both shapes:
  // - { type, url, name, trim }
  // - { kind, title, artist, url, stream_url, ... }
  return {
    kind: source.kind || source.type || null,
    title: source.title || source.name || null,
    artist: source.artist || null,
    album: source.album || null,
    url: source.url || source.stream_url || null,
    stream_url: source.stream_url || null,
    track_id: source.track_id || null,
    art_url: source.art_url || null,
    duration_seconds: source.duration_seconds || null,
    source: source.source || null,
  };
}

function normalizeMu(mu) {
  if (!mu || typeof mu !== 'object') return null;

  const cuts = Array.isArray(mu.cuts_ms)
    ? mu.cuts_ms
        .map((value) => toInt(value))
        .filter((value) => typeof value === 'number' && value >= 0)
        .sort((a, b) => a - b)
    : [];

  if (!cuts.length) return null;

  if (cuts[0] !== 0) cuts.unshift(0);

  const deduped = cuts.filter((value, index, array) => index === 0 || value !== array[index - 1]);

  return {
    cuts_ms: deduped,
    transition_ms: toInt(mu.transition_ms),
    strategy: typeof mu.strategy === 'string' ? mu.strategy : undefined,
    songs: normalizeMuSongs(mu.songs),
    window:
      mu.window && typeof mu.window === 'object'
        ? {
            start_ms: toInt(mu.window.start_ms),
            end_ms: toInt(mu.window.end_ms),
            duration_ms: toInt(mu.window.duration_ms),
          }
        : undefined,
  };
}

function normalizeMuSongs(list) {
  if (!Array.isArray(list)) return undefined;

  const songs = list
    .map((song, index) => {
      if (!song) return null;
      const start = toInt(song.start_ms);
      const end = toInt(song.end_ms);
      if (start === null || end === null || end <= start) return null;

      return {
        index,
        id: song.id || null,
        track_id: song.track_id || null,
        title: song.title || null,
        artist: song.artist || null,
        start_ms: start,
        end_ms: end,
        duration_ms: end - start,
      };
    })
    .filter(Boolean);

  return songs.length ? songs : undefined;
}

function normalizeMuSegments(segments) {
  if (!Array.isArray(segments)) return undefined;

  const mapped = segments
    .map((segment) => {
      if (!segment) return null;
      const index = typeof segment.index === 'number' ? segment.index : null;
      const start = toInt(segment.startMs ?? segment.start_ms);
      const end = toInt(segment.endMs ?? segment.end_ms);
      if (start === null || end === null || end <= start) return null;

      return {
        index,
        start_ms: start,
        end_ms: end,
        duration_ms: end - start,
        captureIndex: segment.captureIndex ?? segment.capture_index ?? null,
      };
    })
    .filter(Boolean);

  return mapped.length ? mapped : undefined;
}

function buildShareUrl(shareId, preferredHost) {
  const base = String(preferredHost || DEFAULT_SHARE_HOST).replace(/\/+$/, '');
  return `${base}/s/${encodeURIComponent(shareId)}`;
}

function sanitizeText(value, max = 500) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function sanitizeToken(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

function clamp01(value) {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function createShareId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return `share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneStore() {
  if (shareStore.size <= MAX_SHARES_IN_MEMORY) return;

  // delete oldest-ish entries (Map keeps insertion order)
  const over = shareStore.size - MAX_SHARES_IN_MEMORY;
  let i = 0;
  for (const key of shareStore.keys()) {
    shareStore.delete(key);
    i += 1;
    if (i >= over) break;
  }
}

module.exports = {
  registerSoundtrackRoutes,
  buildSharePayload,
};
