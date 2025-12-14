// utils/muMapping.js
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

function buildMuSongMapFromQueue(queue = [], trim = null) {
  const tracks = Array.isArray(queue) ? queue.filter(Boolean) : [];
  let cursorMs = 0;
  const raw = tracks.map((t) => {
    const durSec = Number(t.duration_seconds);
    const durMs = durSec > 0 ? Math.round(durSec * 1000) : 0;
    const seg = {
      title: t.title,
      start_ms: cursorMs,
      end_ms: cursorMs + durMs,
      duration_ms: durMs,
    };
    cursorMs += durMs;
    return seg;
  }).filter((s) => s.duration_ms > 0);

  const totalRawMs = cursorMs;
  const startMsFromTrim = toMs(trim?.start_ms);
  const trimStartSeconds = Number(trim?.start_seconds);
  const trimStartMs = Math.max(
    0,
    startMsFromTrim !== null
      ? startMsFromTrim
      : Number.isFinite(trimStartSeconds)
      ? Math.round(trimStartSeconds * 1000)
      : 0,
  );
  let trimEndMs;
  const endMsFromTrim = toMs(trim?.end_ms);
  if (endMsFromTrim !== null) {
    trimEndMs = endMsFromTrim;
  } else if (Number.isFinite(Number(trim?.end_seconds))) {
    trimEndMs = Math.round(Number(trim.end_seconds) * 1000);
  } else if (toMs(trim?.duration_ms) !== null) {
    trimEndMs = trimStartMs + Math.max(0, toMs(trim.duration_ms));
  } else if (Number.isFinite(Number(trim?.duration_seconds))) {
    trimEndMs = trimStartMs + Math.max(0, Math.round(Number(trim.duration_seconds) * 1000));
  } else {
    trimEndMs = totalRawMs;
  }

  const cuts = new Set([0]);
  const songs = [];
  for (const s of raw) {
    const start = Math.max(s.start_ms, trimStartMs);
    const end = Math.min(s.end_ms, trimEndMs);
    if (end <= start) continue;
    songs.push({
      title: s.title,
      start_ms: start - trimStartMs,
      end_ms: end - trimStartMs,
      duration_ms: end - start,
    });
    cuts.add(start - trimStartMs);
    cuts.add(end - trimStartMs);
  }
  const totalMs = Math.max(0, trimEndMs - trimStartMs);
  cuts.add(totalMs);

  const cuts_ms = Array.from(cuts).sort((a, b) => a - b);
  return { cuts_ms, songs, total_ms: totalMs };
}

module.exports = { buildMuSongMapFromQueue };
