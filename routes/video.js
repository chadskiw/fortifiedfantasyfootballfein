// routes/video.js
const express = require('express');
const { Pool } = require('pg');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fetch =
  global.fetch ||
  ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
// TODO(UI): Hook the TrashTalk /p page "Add 30s Clip" flow into these endpoints per Section A6.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: process.env.R2_REGION || 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const STREAM_ACCOUNT = process.env.CF_STREAM_ACCOUNT_ID || '';
const STREAM_API_TOKEN = process.env.CF_STREAM_API_TOKEN || '';
const STREAM_API_BASE = STREAM_ACCOUNT
  ? `https://api.cloudflare.com/client/v4/accounts/${STREAM_ACCOUNT}/stream`
  : '';

function parseCookies(req) {
  if (req.cookies) return req.cookies;
  const out = {};
  const raw = req.headers?.cookie || '';
  raw.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (!key) return;
    out[key] = decodeURIComponent(pair.slice(idx + 1));
  });
  return out;
}

function getCurrentMemberId(req) {
  if (req.member_id) return req.member_id;
  const cookies = parseCookies(req);
  if (
    cookies.ff_member_id &&
    (cookies.ff_logged_in === '1' ||
      cookies.ff_logged_in === 'true' ||
      cookies.ff_logged_in === 1)
  ) {
    return cookies.ff_member_id;
  }
  if (req.headers['x-ff-member-id']) {
    return String(req.headers['x-ff-member-id']);
  }
  if (req.body?.memberId) return String(req.body.memberId);
  if (req.query?.memberId) return String(req.query.memberId);
  return null;
}

function ensureStreamConfig() {
  if (!STREAM_API_BASE || !STREAM_API_TOKEN) {
    throw new Error('stream_config_missing');
  }
}

async function downloadR2Object(key, destPath) {
  const getCmd = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  });
  const obj = await s3.send(getCmd);
  await new Promise((resolve, reject) => {
    const write = fs.createWriteStream(destPath);
    obj.Body.pipe(write);
    obj.Body.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
  });
}

function buildAudioTempoFilters(speed) {
  if (!Number.isFinite(speed) || speed <= 0) return [];
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  const finalTempo = Math.max(0.5, Math.min(2, remaining));
  filters.push(`atempo=${finalTempo.toFixed(3)}`);
  return filters;
}

function safeUnlink(filePath) {
  fs.unlink(filePath, () => {});
}

function normalizeClipWindow(startSeconds, endSeconds, options = {}) {
  const start = Math.max(0, Number(startSeconds) || 0);
  let targetEnd =
    typeof endSeconds === 'number' && Number.isFinite(endSeconds)
      ? endSeconds
      : start + 30;
  if (!Number.isFinite(targetEnd)) targetEnd = start + 30;
  let rawDuration = targetEnd - start;
  if (!Number.isFinite(rawDuration) || rawDuration <= 0) rawDuration = 5;
  const allowOverflow = options?.allowOverflow === true;
  const duration = allowOverflow ? rawDuration : Math.min(30, rawDuration);
  return { start, duration, rawDuration, targetEnd: start + rawDuration };
}

function requireMember(req, res) {
  const memberId = getCurrentMemberId(req);
  if (!memberId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return memberId;
}

router.post('/work', async (req, res) => {
  const memberId = requireMember(req, res);
  if (!memberId) return;

  const partyId = req.body?.party_id || req.body?.partyId || null;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const insert = await pool.query(
      `
        INSERT INTO tt_video_work (member_id, party_id, r2_key_original, status, expires_at)
        VALUES ($1, $2, $3, 'editing', $4)
        RETURNING work_id
      `,
      [memberId, partyId || null, 'pending', expiresAt]
    );

    const workId = insert.rows[0]?.work_id;
    if (!workId) {
      return res.status(500).json({ ok: false, error: 'work_create_failed' });
    }
    const r2Key = `trashtalk-video/originals/${workId}.mp4`;

    await pool.query(
      `UPDATE tt_video_work SET r2_key_original = $2 WHERE work_id = $1`,
      [workId, r2Key]
    );

    const putCmd = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: r2Key,
      ContentType: 'video/mp4',
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 3600 });

    return res.json({
      ok: true,
      work_id: workId,
      uploadUrl,
      r2_key: r2Key,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('[video:work:create]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'video_work_create_failed' });
  }
});

router.get('/work/:workId', async (req, res) => {
  const memberId = requireMember(req, res);
  if (!memberId) return;
  const workId = Number(req.params.workId);
  if (!Number.isFinite(workId)) {
    return res.status(400).json({ ok: false, error: 'invalid_work_id' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT work_id, member_id, party_id, r2_key_original, status, expires_at, duration_seconds
         FROM tt_video_work
        WHERE work_id = $1`,
      [workId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'work_not_found' });
    }
    const work = rows[0];
    if (String(work.member_id || '').toLowerCase() !== memberId.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (!work.r2_key_original) {
      return res.status(409).json({ ok: false, error: 'original_missing' });
    }

    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: work.r2_key_original,
    });
    const playbackUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });

    return res.json({
      ok: true,
      work_id: work.work_id,
      playbackUrl,
      status: work.status,
      expires_at: work.expires_at,
      duration_seconds: work.duration_seconds,
    });
  } catch (err) {
    console.error('[video:work:get]', err);
    return res.status(500).json({ ok: false, error: 'video_work_fetch_failed' });
  }
});

router.post('/work/:workId/clip', async (req, res) => {
  const memberId = requireMember(req, res);
  if (!memberId) return;
  const workId = Number(req.params.workId);
  if (!Number.isFinite(workId)) {
    return res.status(400).json({ ok: false, error: 'invalid_work_id' });
  }
  try {
    ensureStreamConfig();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  const { startSeconds, endSeconds } = req.body || {};
  const fitToThirty =
    req.body?.fitToThirty === true ||
    req.body?.fitToThirty === 'true' ||
    req.body?.fitToThirty === 1 ||
    req.body?.fitToThirty === '1' ||
    req.body?.fit_to_thirty === true ||
    req.body?.fit_to_thirty === 'true' ||
    req.body?.fit_to_thirty === 1 ||
    req.body?.fit_to_thirty === '1';
  const { start, duration, rawDuration } = normalizeClipWindow(
    startSeconds,
    endSeconds,
    { allowOverflow: fitToThirty }
  );
  const needsSpeedUp = Boolean(fitToThirty && rawDuration > 30.01);
  const ffmpegDuration = needsSpeedUp ? rawDuration : duration;

  let work;
  try {
    const { rows } = await pool.query(
      `SELECT work_id, member_id, party_id, r2_key_original
         FROM tt_video_work
        WHERE work_id = $1`,
      [workId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'work_not_found' });
    }
    work = rows[0];
  } catch (err) {
    console.error('[video:clip:load]', err);
    return res.status(500).json({ ok: false, error: 'video_work_fetch_failed' });
  }

  if (String(work.member_id || '').toLowerCase() !== memberId.toLowerCase()) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!work.r2_key_original) {
    return res.status(409).json({ ok: false, error: 'original_missing' });
  }

  const tmpDir = os.tmpdir();
  const sourcePath = path.join(
    tmpDir,
    `video-work-${workId}-${Date.now()}-src.mp4`
  );
  const clipPath = path.join(
    tmpDir,
    `video-work-${workId}-${Date.now()}-clip.mp4`
  );

  try {
    await pool.query(
      `UPDATE tt_video_work SET status = 'processing', updated_at = NOW() WHERE work_id = $1`,
      [workId]
    );

    await downloadR2Object(work.r2_key_original, sourcePath);

    await new Promise((resolve, reject) => {
      const command = ffmpeg(sourcePath)
        .setStartTime(start)
        .duration(ffmpegDuration)
        .outputOptions(['-movflags faststart', '-preset veryfast'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .size('?x720');

      if (needsSpeedUp) {
        const speed = rawDuration / 30;
        command.videoFilters(`setpts=(PTS-STARTPTS)/${speed.toFixed(6)}`);
        const audioFilters = buildAudioTempoFilters(speed);
        if (audioFilters.length) {
          command.audioFilters(audioFilters.join(','));
        }
      }

      command
        .output(clipPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const form = new FormData();
    form.append('file', fs.createReadStream(clipPath), {
      filename: `party-clip-${workId}.mp4`,
      contentType: 'video/mp4',
    });

    const streamResp = await fetch(STREAM_API_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STREAM_API_TOKEN}`,
        ...form.getHeaders(),
      },
      body: form,
    });
    const streamData = await streamResp.json().catch(() => ({}));
    if (!streamResp.ok || streamData?.success === false) {
      console.error('[video:clip:stream]', streamData);
      throw new Error('stream_upload_failed');
    }
    const streamUid =
      streamData?.result?.uid || streamData?.result?.id || null;
    if (!streamUid) {
      throw new Error('stream_uid_missing');
    }

    const finalDuration = needsSpeedUp
      ? 30
      : Math.min(30, Math.max(1, Math.round(duration)));

    await pool.query(
      `INSERT INTO tt_video (stream_uid, owner_member_id, party_id, kind, duration_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [streamUid, memberId, work.party_id, 'clip', finalDuration]
    );

    await pool.query(
      `UPDATE tt_video_work
          SET status = 'clipped',
              updated_at = NOW()
        WHERE work_id = $1`,
      [workId]
    );

    res.json({
      ok: true,
      work_id: workId,
      stream_uid: streamUid,
      duration_seconds: finalDuration,
    });
  } catch (err) {
    console.error('[video:clip]', err);
    await pool.query(
      `UPDATE tt_video_work SET status = 'editing', updated_at = NOW() WHERE work_id = $1`,
      [workId]
    );
    const status =
      err?.message === 'stream_upload_failed' ||
      err?.message === 'stream_uid_missing'
        ? 502
        : err?.message === 'stream_config_missing'
          ? 500
          : 500;
    return res.status(status).json({ ok: false, error: err.message || 'clip_failed' });
  } finally {
    safeUnlink(sourcePath);
    safeUnlink(clipPath);
  }
});

// Placeholder for scheduled cleanup hook (Section A7/B6).
router.post('/cron/expire', async (_req, res) => {
  res.status(202).json({
    ok: true,
    message:
      'Cron cleanup not implemented yet. This endpoint will later trim/expire abandoned works.',
  });
});

module.exports = router;
