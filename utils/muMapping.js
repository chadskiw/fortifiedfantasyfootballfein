// utils/muMapping.js
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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
  const trimStartMs = Math.max(0, Math.round((trim?.start_seconds ?? 0) * 1000));
  const trimEndMs = trim?.end_seconds
    ? Math.round(trim.end_seconds * 1000)
    : trim?.duration_seconds
    ? trimStartMs + Math.round(trim.duration_seconds * 1000)
    : totalRawMs;

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
