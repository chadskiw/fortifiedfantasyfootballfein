// routes/soundtrack.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { applyPrivacyToSharedCaptures } = require('../utils/privacyShare');
const { getCurrentIdentity } = require('../services/identity');

let buildMuSongMapFromQueue = null;
try {
  ({ buildMuSongMapFromQueue } = require('../utils/muMapping'));
} catch (err) {
  // optional; Mu can still be provided by client
}

const router = express.Router();
router.use(express.json({ limit: '6mb', strict: false }));

const DEFAULT_SHARE_HOST = (process.env.SOUNDTRACK_SHARE_HOST || 'https://soundtrack-share.pages.dev').replace(
  /\/+$/,
  '',
);

// NOTE: in-memory (resets on deploy/restart). Good for now.
const shareStore = new Map();
const MAX_SHARES_IN_MEMORY = 2000;

async function respondWithShare(req, res, shareId) {
  if (!shareId || !shareStore.has(shareId)) {
    return res.status(404).json({ ok: false, error: 'share_not_found' });
  }
  const shareEntry = shareStore.get(shareId);
  const identity = await getCurrentIdentity(req, pool).catch(() => null);
  const viewerMemberId = identity?.memberId || identity?.member_id || null;
  const ownerMemberId = shareEntry?.member_id || shareEntry?.memberId || null;
  const originalCaptures = Array.isArray(shareEntry?.captures) ? shareEntry.captures : [];
  const capturesClone = originalCaptures.map((capture) => ({ ...capture }));
  let capturesWithPrivacy = capturesClone;
  try {
    capturesWithPrivacy = await applyPrivacyToSharedCaptures({
      viewerMemberId,
      ownerMemberId,
      captures: capturesClone,
    });
  } catch (err) {
    console.warn('[soundtrack] privacy masking failed', err);
  }
  return res.json({
    ok: true,
    share: {
      ...shareEntry,
      captures: capturesWithPrivacy,
    },
  });
}

router.post('/share', async (req, res) => {
  try {
    const payload = buildSharePayload(req?.body || {});
    shareStore.set(payload.share_id, payload);
    pruneStore();
    res.json({ ok: true, share_id: payload.share_id, share_url: payload.share_url, share: payload });
  } catch (err) {
    console.warn('[soundtrack] share build failed', err);
    res.status(400).json({ ok: false, error: err?.message || 'share_failed' });
  }
});

// supports your Cloudflare Pages fetch: /api/soundtrack/share?id=XYZ
router.get('/share', async (req, res) => {
  const shareId = sanitizeToken(req.query?.id || req.query?.share_id || '');
  await respondWithShare(req, res, shareId);
});

// optional: /api/soundtrack/share/:id
router.get('/share/:id', async (req, res) => {
  const shareId = sanitizeToken(req.params?.id || '');
  await respondWithShare(req, res, shareId);
});

function pruneStore() {
  if (shareStore.size <= MAX_SHARES_IN_MEMORY) return;
  const keys = Array.from(shareStore.keys());
  const dropCount = Math.max(1, keys.length - MAX_SHARES_IN_MEMORY);
  for (let i = 0; i < dropCount; i += 1) {
    shareStore.delete(keys[i]);
  }
}

function buildSharePayload(body = {}) {
  const now = new Date().toISOString();
  const shareId = sanitizeToken(body.share_id) || createShareId(body);

  const playbackMode = normalizePlaybackMode(body.playback_mode || body.playbackMode);
  const captures = normalizeCaptures(body.captures || body.media || body.frames || []);
  if (!captures.length) throw new Error('missing_captures');

  const audioTrim = normalizeAudioTrim(body.audio_trim || body.audioTrim || null);
  const clipRange = normalizeClipRange(body.clip_range || body.clipRange || {});
  const audioSource = normalizeAudioSource(body.audio_source || body.audioSource || null);

  // queue must include duration_seconds for Mu build to work
  const audioQueue = Array.isArray(body.audio_queue) ? body.audio_queue : null;

  // 1) accept mu if client provides it
  let mu = normalizeMu(body.mu);

  // 2) if MuMode but mu missing, try building from queue + trim + captures
  if (!mu && playbackMode === 'mu') {
    mu = tryBuildMu({ audioQueue, audioTrim, audioSource, captureCount: captures.length });
  }

  const muSegments = mu ? buildMuSegments(mu, captures.length) : undefined;

  const shareHost = typeof body.share_host === 'string' ? body.share_host : null;
  const shareUrl = buildShareUrl(shareId, shareHost);

  const audioUrl = audioSource?.stream_url || audioSource?.url || null;
  const coverUrl = captures[0]?.thumbnail_url || captures[0]?.url || captures[0]?.uri || null;

  const payload = {
    share_id: shareId,

    member_id: body.member_id || null,
    handle: sanitizeHandle(body.handle),
    scope: sanitizeScope(body.scope),

    title: sanitizeText(body.title, 120) || null,
    description: sanitizeText(body.description, 280) || null,

    playback_mode: playbackMode,
    playback_mode_effective: normalizePlaybackMode(body.playback_mode_effective || playbackMode),

    captures,
    media_ids: normalizeMediaIds(body.media_ids, captures),

    clip_range: clipRange,
    audio_trim: audioTrim,
    audio_source: audioSource,
    audio_url: audioUrl,
    cover_url: coverUrl,

    audio_queue: audioQueue || undefined,

    mu: mu || null,
    mu_segments: muSegments || undefined,
    mu_available: Boolean(mu?.cuts_ms?.length && mu.cuts_ms.length >= 2),

    share_url: shareUrl,

    created_at: body.created_at || now,
    updated_at: now,
  };

  return payload;
}

function tryBuildMu({ audioQueue, audioTrim, audioSource, captureCount }) {
  // A) Best: playlist/queue with durations (song-change aware)
  if (buildMuSongMapFromQueue && Array.isArray(audioQueue) && audioQueue.length) {
    const songMap = buildMuSongMapFromQueue(audioQueue, audioTrim);
    if (songMap?.cuts_ms?.length >= 2) {
      return buildPhotoCutsFromSongMap(songMap, captureCount);
    }
  }

  // B) Fallback: single-track duration (evenly split across captures)
  const durationSeconds = toNumber(audioSource?.duration_seconds);
  const durationMsFromSource = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null;
  const durationMsFromTrim = toInt(audioTrim?.duration_ms);

  const totalMs =
    durationMsFromTrim ??
    durationMsFromSource ??
    (audioTrim?.start_ms != null && audioTrim?.end_ms != null
      ? Math.max(0, toInt(audioTrim.end_ms) - toInt(audioTrim.start_ms))
      : null);

  if (!totalMs || totalMs <= 0) return null;

  const segments = Math.max(1, Number.isFinite(captureCount) ? captureCount : 1);
  const cuts = [0];
  for (let i = 1; i < segments; i += 1) {
    cuts.push(Math.round((totalMs * i) / segments));
  }
  cuts.push(totalMs);

  return {
    cuts_ms: dedupeSorted(cuts),
    transition_ms: 350,
    strategy: 'fallback_even',
    window: { start_ms: 0, end_ms: totalMs, duration_ms: totalMs },
  };
}

// If captureCount > songs, subdivide within songs.
// If captureCount < songs, group songs so capture changes only at song boundaries.
function buildPhotoCutsFromSongMap(songMap, captureCount) {
  const songs = Array.isArray(songMap.songs) ? songMap.songs : [];
  const totalMs = toInt(songMap.total_ms);
  if (!songs.length || !totalMs || totalMs <= 0) {
    return songMap?.cuts_ms?.length >= 2 ? songMap : null;
  }

  const photos = Math.max(1, Number.isFinite(captureCount) ? captureCount : 1);

  // group songs into photos buckets
  if (photos <= songs.length) {
    const target = totalMs / photos;
    const cuts = [0];
    let bucket = 0;
    let acc = 0;
    for (let i = 0; i < songs.length; i += 1) {
      acc += Math.max(0, toInt(songs[i].duration_ms) || (songs[i].end_ms - songs[i].start_ms));
      const isLastBucket = bucket >= photos - 1;
      if (!isLastBucket && acc >= target) {
        cuts.push(Math.max(0, toInt(songs[i].end_ms)));
        bucket += 1;
        acc = 0;
      }
    }
    cuts.push(totalMs);
    return {
      cuts_ms: dedupeSorted(cuts),
      transition_ms: 350,
      strategy: 'songs_grouped',
      songs,
      window: { start_ms: 0, end_ms: totalMs, duration_ms: totalMs },
      total_ms: totalMs,
    };
  }

  // photos > songs: subdivide inside each song
  const extra = photos - songs.length;
  const weights = songs.map((s) => Math.max(1, toInt(s.duration_ms) || (s.end_ms - s.start_ms)));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const perSong = songs.map(() => 1);
  let remaining = extra;

  // proportional extras
  const fractional = weights.map((w) => (w / weightSum) * extra);
  const baseExtras = fractional.map((x) => Math.floor(x));
  let used = baseExtras.reduce((a, b) => a + b, 0);
  for (let i = 0; i < baseExtras.length; i += 1) perSong[i] += baseExtras[i];
  remaining -= used;

  // distribute leftover by highest remainder
  const remainders = fractional
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r);
  for (let k = 0; k < remaining; k += 1) {
    perSong[remainders[k % remainders.length].i] += 1;
  }

  const cuts = [0];
  for (let i = 0; i < songs.length; i += 1) {
    const start = Math.max(0, toInt(songs[i].start_ms));
    const end = Math.max(start, toInt(songs[i].end_ms));
    const slots = perSong[i];
    const span = Math.max(1, end - start);

    for (let j = 1; j <= slots; j += 1) {
      cuts.push(start + Math.round((span * j) / slots));
    }
  }

  cuts[0] = 0;
  cuts[cuts.length - 1] = totalMs;

  return {
    cuts_ms: dedupeSorted(cuts),
    transition_ms: 350,
    strategy: 'songs_subdivided',
    songs,
    window: { start_ms: 0, end_ms: totalMs, duration_ms: totalMs },
    total_ms: totalMs,
  };
}

function buildMuSegments(mu, captureCount) {
  const cuts = Array.isArray(mu?.cuts_ms) ? mu.cuts_ms : [];
  if (cuts.length < 2) return undefined;

  const segments = [];
  const totalSegments = cuts.length - 1;
  const cappedCaptures = Math.max(1, Number.isFinite(captureCount) ? captureCount : 1);

  for (let i = 0; i < totalSegments; i += 1) {
    const start = toInt(cuts[i]);
    const end = toInt(cuts[i + 1]);
    if (start == null || end == null || end <= start) continue;
    const captureIndex = Math.min(cappedCaptures - 1, i); // sequential
    segments.push({
      index: i,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      captureIndex,
    });
  }

  return segments.length ? segments : undefined;
}

function normalizePlaybackMode(mode) {
  const v = String(mode || '').trim().toLowerCase();
  return v === 'mu' ? 'mu' : 'classic';
}

function sanitizeHandle(handle) {
  if (!handle) return null;
  const trimmed = String(handle).trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

function sanitizeScope(scope) {
  const s = String(scope || '').trim().toLowerCase();
  return s === 'trip' || s === 'life' ? s : 'day';
}

function normalizeMediaIds(mediaIds, captures) {
  if (Array.isArray(mediaIds) && mediaIds.length) return mediaIds.map((v) => String(v));
  return captures.map((c) => c.id).filter(Boolean);
}

function normalizeCaptures(input) {
  if (!Array.isArray(input)) return [];
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
  if (end <= start) return { start: 0, end: 1 };
  return { start, end };
}

function normalizeAudioTrim(trim) {
  if (!trim || typeof trim !== 'object') return null;
  const startMs = toInt(trim.start_ms ?? trim.startMs);
  const endMs = toInt(trim.end_ms ?? trim.endMs);
  const durationMs = toInt(trim.duration_ms ?? trim.durationMs);
  return {
    start_ms: startMs ?? null,
    end_ms: endMs ?? null,
    duration_ms: durationMs ?? (startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null),
    start_pct: clamp01(trim.start_pct),
    end_pct: clamp01(trim.end_pct),
  };
}

function normalizeAudioSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    kind: source.kind || source.type || null,
    title: source.title || source.name || null,
    artist: source.artist || null,
    album: source.album || null,
    url: source.url || null,
    stream_url: source.stream_url || source.streamUrl || null,
    track_id: source.track_id || source.trackId || null,
    art_url: source.art_url || source.artUrl || null,
    duration_seconds: toNumber(source.duration_seconds ?? source.durationSeconds) ?? null,
    source: source.source || null,
  };
}

function normalizeMu(mu) {
  if (!mu || typeof mu !== 'object') return null;
  const cuts = Array.isArray(mu.cuts_ms)
    ? mu.cuts_ms.map(toInt).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b)
    : [];
  if (cuts.length < 2) return null;
  if (cuts[0] !== 0) cuts.unshift(0);
  const deduped = dedupeSorted(cuts);
  return {
    cuts_ms: deduped,
    transition_ms: toInt(mu.transition_ms) ?? undefined,
    strategy: typeof mu.strategy === 'string' ? mu.strategy : undefined,
    songs: Array.isArray(mu.songs) ? mu.songs : undefined,
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

function buildShareUrl(shareId, preferredHost) {
  const base = (preferredHost || DEFAULT_SHARE_HOST).replace(/\/+$/, '');
  return `${base}/s/${encodeURIComponent(shareId)}`;
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

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dedupeSorted(arr) {
  const out = [];
  for (const v of arr) {
    if (!out.length || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

function sanitizeText(value, max = 500) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function sanitizeToken(value) {
  if (!value) return '';
  const cleaned = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned;
}

function createShareId(body = {}) {
  const handle = sanitizeToken(body.handle || '') || 'soundtrack';
  const scope = sanitizeToken(body.scope || 'day').toLowerCase() || 'day';
  const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${handle}-${scope}-${suffix}`;
}

// Export router (middleware). Keep helpers attached for debugging if you want.
module.exports = router;
module.exports.buildSharePayload = buildSharePayload;
