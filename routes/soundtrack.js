const { randomUUID } = require('crypto');

const DEFAULT_SHARE_HOST = process.env.SOUNDTRACK_SHARE_HOST || 'https://soundtrack-share.pages.dev';
const shareStore = new Map();

function registerSoundtrackRoutes(app) {
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') {
    throw new Error('Soundtrack routes require an Express-style app instance.');
  }

  app.post('/api/soundtrack/share', async (req, res) => {
    try {
      const payload = buildSharePayload(req?.body || {});
      shareStore.set(payload.share_id, payload);
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

  app.get('/api/soundtrack/share/:id', (req, res) => {
    const shareId = String(req.params?.id || '').trim();
    if (!shareId || !shareStore.has(shareId)) {
      res.status(404).json({ ok: false, error: 'share_not_found' });
      return;
    }
    res.json({ ok: true, share: shareStore.get(shareId) });
  });
}

function buildSharePayload(body = {}) {
  const now = new Date().toISOString();
  const shareId = String(body.share_id || createShareId());
  const playbackMode = normalizePlaybackMode(body.playback_mode);
  const playbackModeEffective = normalizePlaybackMode(body.playback_mode_effective || playbackMode);
  const captures = normalizeCaptures(body.captures);
  if (!captures.length) {
    throw new Error('missing_captures');
  }
  const mediaIds = normalizeMediaIds(body.media_ids, captures);
  const audioTrim = normalizeAudioTrim(body.audio_trim);
  const clipRange = normalizeClipRange(body.clip_range);
  const audioSource = normalizeAudioSource(body.audio_source);
  const mu = normalizeMu(body.mu);
  const payload = {
    share_id: shareId,
    member_id: body.member_id || null,
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
    audio_queue: Array.isArray(body.audio_queue) ? body.audio_queue : undefined,
    mu,
    mu_segments: normalizeMuSegments(body.mu_segments),
    client: body.client || 'unknown',
    share_url: buildShareUrl(shareId, body.share_host),
    created_at: body.created_at || now,
    updated_at: now,
  };
  payload.mu_available = Boolean(mu?.cuts_ms?.length);
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
  if (scope === 'trip' || scope === 'life') {
    return scope;
  }
  return 'day';
}

function buildScopeMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }
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
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item, idx) => {
      if (!item) return null;
      const url = item.url || item.uri;
      if (!url) return null;
      const type = item.type === 'video' ? 'video' : 'photo';
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
  const start = clamp01(range.start);
  const end = clamp01(range.end);
  if (end <= start) {
    return { start: 0, end: 1 };
  }
  return { start, end };
}

function normalizeAudioTrim(trim = {}) {
  const startMs = toInt(trim.start_ms ?? trim.startMs);
  const endMs = toInt(trim.end_ms ?? trim.endMs);
  const durationMs = toInt(trim.duration_ms ?? trim.durationMs);
  return {
    start_ms: startMs ?? null,
    end_ms: endMs ?? null,
    duration_ms: durationMs ?? (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null),
    start_pct: clamp01(trim.start_pct),
    end_pct: clamp01(trim.end_pct),
  };
}

function normalizeAudioSource(source) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  return {
    kind: source.kind || null,
    title: source.title || null,
    artist: source.artist || null,
    album: source.album || null,
    url: source.url || null,
    stream_url: source.stream_url || null,
    track_id: source.track_id || null,
    art_url: source.art_url || null,
    duration_seconds: source.duration_seconds || null,
    source: source.source || null,
  };
}

function normalizeMu(mu) {
  if (!mu || typeof mu !== 'object') {
    return null;
  }
  const cuts = Array.isArray(mu.cuts_ms)
    ? mu.cuts_ms
        .map((value) => toInt(value))
        .filter((value) => typeof value === 'number' && value >= 0)
        .sort((a, b) => a - b)
    : [];
  if (!cuts.length) {
    return null;
  }
  if (cuts[0] !== 0) {
    cuts.unshift(0);
  }
  const deduped = cuts.filter((value, index, array) => index === 0 || value !== array[index - 1]);
  return {
    cuts_ms: deduped,
    transition_ms: toInt(mu.transition_ms),
    strategy: typeof mu.strategy === 'string' ? mu.strategy : undefined,
    songs: normalizeMuSongs(mu.songs),
    window: mu.window && typeof mu.window === 'object'
      ? {
          start_ms: toInt(mu.window.start_ms),
          end_ms: toInt(mu.window.end_ms),
          duration_ms: toInt(mu.window.duration_ms),
        }
      : undefined,
  };
}

function normalizeMuSongs(list) {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const songs = list
    .map((song, index) => {
      if (!song) return null;
      const start = toInt(song.start_ms);
      const end = toInt(song.end_ms);
      if (start === null || end === null || end <= start) {
        return null;
      }
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
  if (!Array.isArray(segments)) {
    return undefined;
  }
  const mapped = segments
    .map((segment) => {
      if (!segment) return null;
      const index = typeof segment.index === 'number' ? segment.index : null;
      const start = toInt(segment.startMs ?? segment.start_ms);
      const end = toInt(segment.endMs ?? segment.end_ms);
      if (start === null || end === null || end <= start) {
        return null;
      }
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
  const base = (preferredHost || DEFAULT_SHARE_HOST).replace(/\/+$/, '');
  return `${base}/s/${encodeURIComponent(shareId)}`;
}

function clamp01(value) {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(1, Math.max(0, num));
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function createShareId() {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  registerSoundtrackRoutes,
  buildSharePayload,
};
