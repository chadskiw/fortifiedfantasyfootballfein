// routes/audio.js
//
// Long-form audio storage on R2 with optional hero image/video.
//
// Endpoints:
//   POST   /api/audio/track              -> create track + presigned upload URL
//   POST   /api/audio/track/:id/finalize -> transcode to MP3, store final R2 object
//   POST   /api/audio/track/:id/hero     -> attach hero image/video
//   GET    /api/audio/track/:id          -> fetch metadata + signed playback URL

const express = require('express');
const fs = require('fs');
const path = require('path');

const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const pool = require('../src/db/pool');
const r2 = require('../src/r2');
const { getCurrentIdentity } = require('../services/identity');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const router = express.Router();
const bucket = process.env.R2_BUCKET;
const MAX_AUDIO_DURATION_SECONDS = 3 * 60 * 60; // 3 hours

async function fetchPartySummary(partyId) {
  if (!partyId) return null;
  const { rows } = await pool.query(
    `
      SELECT party_id,
             host_handle,
             visibility_mode,
             party_type,
             state
        FROM tt_party
       WHERE party_id = $1
       LIMIT 1
    `,
    [partyId]
  );
  return rows[0] || null;
}

function isPartyPublic(party) {
  if (!party) return false;
  const visibility = String(party.visibility_mode || '').toLowerCase();
  const type = String(party.party_type || '').toLowerCase();
  return visibility === 'public_party' || type === 'public';
}

async function fetchPartyMembership(partyId, handle) {
  if (!partyId || !handle) return null;
  const { rows } = await pool.query(
    `
      SELECT access_level
        FROM tt_party_member
       WHERE party_id = $1
         AND handle = $2
       LIMIT 1
    `,
    [partyId, handle]
  );
  return rows[0] || null;
}

async function ensurePartyAudioAccess(partyId, identity) {
  const party = await fetchPartySummary(partyId);
  if (!party) {
    const err = new Error('party_not_found');
    err.status = 404;
    throw err;
  }
  if (String(party.state || '').toLowerCase() === 'cut') {
    const err = new Error('party_cut');
    err.status = 410;
    throw err;
  }
  const hostHandle = (party.host_handle || '').trim().toLowerCase();
  const viewerHandle = (identity?.handle || '').trim().toLowerCase();
  const isHost = hostHandle && viewerHandle && hostHandle === viewerHandle;
  if (isHost) {
    return { party, membership: { access_level: 'host' } };
  }
  const partyIsPublic = isPartyPublic(party);
  if (!identity) {
    if (partyIsPublic) {
      return { party, membership: null };
    }
    const err = new Error('not_logged_in');
    err.status = 401;
    throw err;
  }
  const membership = await fetchPartyMembership(partyId, identity.handle);
  if (!membership) {
    if (partyIsPublic) {
      return { party, membership: null };
    }
    const err = new Error('not_invited');
    err.status = 403;
    throw err;
  }
  const accessLevel = String(membership.access_level || '').toLowerCase();
  if (accessLevel === 'declined') {
    const err = new Error('party_declined');
    err.status = 403;
    throw err;
  }
  if (accessLevel === 'card') {
    const err = new Error('not_checked_in');
    err.status = 403;
    throw err;
  }
  return { party, membership };
}

async function loadTracksForClause(whereClause, params, limit) {
  const limitParamIndex = params.length + 1;
  const query = `
    SELECT audio_id,
           r2_key_final,
           owner_member_id,
           party_id,
           duration_seconds,
           format,
           title,
           description,
           hero_kind,
           hero_ref,
           created_at,
           updated_at
      FROM tt_audio_track
     WHERE r2_key_final IS NOT NULL
       AND r2_key_final <> 'pending'
       AND ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${limitParamIndex}
  `;
  const values = params.concat(limit);
  const { rows } = await pool.query(query, values);
  return rows;
}

async function serializeTracks(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return [];
  }
  const hydrated = [];
  for (const row of rows) {
    if (!row?.r2_key_final) continue;
    try {
      const playbackUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({
          Bucket: bucket,
          Key: row.r2_key_final,
        }),
        { expiresIn: 3600 }
      );
      hydrated.push({
        audio_id: row.audio_id,
        playbackUrl,
        owner_member_id: row.owner_member_id,
        party_id: row.party_id,
        duration_seconds: row.duration_seconds,
        format: row.format,
        title: row.title,
        description: row.description,
        hero_kind: row.hero_kind || 'none',
        hero_ref: row.hero_ref || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    } catch (err) {
      console.error('[audio:list] failed to sign playback url', err);
    }
  }
  return hydrated;
}

// --- Helper: get current member id (adjust if your auth is different) ---
function getCurrentMemberId(req) {
  // If you have a centralized auth middleware, mirror what trashtalk/party routes do.
  // Fallbacks here are just guesses.
  return (
    req.memberId ||
    (req.user && (req.user.member_id || req.user.memberId)) ||
    (req.cookies && (req.cookies.ff_member_id || req.cookies.ff_member)) ||
    null
  );
}

// --- Helper: small wrapper around pg client usage ---
async function withPg(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// --- POST /api/audio/track ---
// Create a row and return a presigned PUT URL for the raw upload.
router.post('/track', async (req, res, next) => {
  try {
    const memberId = getCurrentMemberId(req);
    if (!memberId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { party_id, title, description } = req.body || {};

    const row = await withPg(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tt_audio_track (
           owner_member_id,
           party_id,
           r2_key_final,
           format,
           title,
           description
         )
         VALUES ($1, $2, 'pending', 'mp3', $3, $4)
         RETURNING audio_id`,
        [memberId, party_id || null, title || null, description || null]
      );
      return rows[0];
    });

    const audioId = row.audio_id;
    const rawKey = `trashtalk-audio/uploads/${audioId}`;

    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: rawKey,
      ContentType: 'audio/*', // browser will set a more specific type
    });

    const uploadUrl = await getSignedUrl(r2, putCmd, { expiresIn: 3600 });

    res.json({
      ok: true,
      audio_id: audioId,
      uploadUrl,
      rawKey,
    });
  } catch (err) {
    console.error('[audio/track] error', err);
    next(err);
  }
});

// --- POST /api/audio/track/:audioId/finalize ---
// After the client uploads the raw file to R2, call this to:
// - download the raw file
// - transcode to MP3
// - upload final MP3 to R2
// - update tt_audio_track with final key + duration
router.post('/track/:audioId/finalize', async (req, res, next) => {
  const audioId = Number(req.params.audioId);
  if (!Number.isFinite(audioId)) {
    return res.status(400).json({ ok: false, error: 'invalid_audio_id' });
  }

  try {
    const memberId = getCurrentMemberId(req);
    if (!memberId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const track = await withPg(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tt_audio_track WHERE audio_id = $1`,
        [audioId]
      );
      return rows[0] || null;
    });

    if (!track) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (track.owner_member_id && track.owner_member_id !== memberId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const rawKey = `trashtalk-audio/uploads/${audioId}`;
    const tmpDir = '/tmp';
    const rawPath = path.join(tmpDir, `audio-${audioId}-raw`);
    const finalPath = path.join(tmpDir, `audio-${audioId}-final.mp3`);

    // 1) Download raw upload from R2
    const getCmd = new GetObjectCommand({
      Bucket: bucket,
      Key: rawKey,
    });

    const obj = await r2.send(getCmd);

    await new Promise((resolve, reject) => {
      const write = fs.createWriteStream(rawPath);
      obj.Body.pipe(write);
      obj.Body.on('error', reject);
      write.on('finish', resolve);
      write.on('error', reject);
    });

    // 2) Convert to MP3 (even if it already is MP3, this normalizes)
    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .audioCodec('libmp3lame')
        .audioBitrate('160k')
        .toFormat('mp3')
        .on('end', resolve)
        .on('error', reject)
        .save(finalPath);
    });

    // 3) Probe duration
    const durationSeconds = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(finalPath, (err, metadata) => {
        if (err) return reject(err);
        const dur = metadata?.format?.duration;
        resolve(dur ? Math.round(dur) : null);
      });
    });

    if (
      Number.isFinite(durationSeconds) &&
      durationSeconds > MAX_AUDIO_DURATION_SECONDS
    ) {
      fs.unlink(rawPath, () => {});
      fs.unlink(finalPath, () => {});
      return res.status(422).json({
        ok: false,
        error: 'audio_too_long',
        max_seconds: MAX_AUDIO_DURATION_SECONDS,
        duration_seconds: durationSeconds,
      });
    }

    const finalKey = `trashtalk-audio/final/${audioId}.mp3`;
    const fileData = fs.readFileSync(finalPath);

    // 4) Upload final MP3 to R2
    await r2.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        Body: fileData,
        ContentType: 'audio/mpeg',
      })
    );

    // 5) Update DB
    await withPg((client) =>
      client.query(
        `UPDATE tt_audio_track
         SET r2_key_final = $2,
             r2_key_original = $3,
             duration_seconds = $4,
             format = 'mp3',
             updated_at = NOW()
         WHERE audio_id = $1`,
        [audioId, finalKey, rawKey, durationSeconds]
      )
    );

    // Cleanup tmp files (ignore errors)
    fs.unlink(rawPath, () => {});
    fs.unlink(finalPath, () => {});

    res.json({
      ok: true,
      audio_id: audioId,
      r2_key_final: finalKey,
      duration_seconds: durationSeconds,
    });
  } catch (err) {
    console.error('[audio/finalize] error', err);
    next(err);
  }
});

// --- POST /api/audio/track/:audioId/hero ---
// Attach hero image/video/none for this audio track.
router.post('/track/:audioId/hero', async (req, res, next) => {
  const audioId = Number(req.params.audioId);
  if (!Number.isFinite(audioId)) {
    return res.status(400).json({ ok: false, error: 'invalid_audio_id' });
  }

  try {
    const memberId = getCurrentMemberId(req);
    if (!memberId) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { hero_kind, hero_ref } = req.body || {};
    const allowedKinds = ['none', 'image', 'video'];
    const kind = allowedKinds.includes(hero_kind) ? hero_kind : 'none';

    const updated = await withPg(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tt_audio_track WHERE audio_id = $1`,
        [audioId]
      );
      const track = rows[0];
      if (!track) return null;
      if (track.owner_member_id && track.owner_member_id !== memberId) {
        return 'forbidden';
      }
      await client.query(
        `UPDATE tt_audio_track
         SET hero_kind = $2,
             hero_ref = $3,
             updated_at = NOW()
         WHERE audio_id = $1`,
        [audioId, kind, hero_ref || null]
      );
      return { hero_kind: kind, hero_ref: hero_ref || null };
    });

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (updated === 'forbidden') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    res.json({ ok: true, audio_id: audioId, ...updated });
  } catch (err) {
    console.error('[audio/hero] error', err);
    next(err);
  }
});

// --- GET /api/audio/track/:audioId ---
// Return metadata + a signed playback URL for the MP3.
router.get('/track/:audioId', async (req, res, next) => {
  const audioId = Number(req.params.audioId);
  if (!Number.isFinite(audioId)) {
    return res.status(400).json({ ok: false, error: 'invalid_audio_id' });
  }

  try {
    const track = await withPg(async (client) => {
      const { rows } = await client.query(
        `SELECT audio_id,
                r2_key_final,
                owner_member_id,
                party_id,
                duration_seconds,
                format,
                title,
                description,
                hero_kind,
                hero_ref,
                created_at,
                updated_at
         FROM tt_audio_track
         WHERE audio_id = $1`,
        [audioId]
      );
      return rows[0] || null;
    });

    if (!track) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (!track.r2_key_final || track.r2_key_final === 'pending') {
      return res.status(409).json({ ok: false, error: 'not_ready' });
    }

    const getCmd = new GetObjectCommand({
      Bucket: bucket,
      Key: track.r2_key_final,
    });

    const playbackUrl = await getSignedUrl(r2, getCmd, { expiresIn: 3600 });

    res.json({
      ok: true,
      audio_id: track.audio_id,
      playbackUrl,
      owner_member_id: track.owner_member_id,
      party_id: track.party_id,
      duration_seconds: track.duration_seconds,
      format: track.format,
      title: track.title,
      description: track.description,
      hero_kind: track.hero_kind,
      hero_ref: track.hero_ref,
      created_at: track.created_at,
      updated_at: track.updated_at,
    });
  } catch (err) {
    console.error('[audio/get] error', err);
    next(err);
  }
});

router.get('/tracks', async (req, res, next) => {
  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
    const partyId = (req.query.party_id || '').trim();
    const audience = String(req.query.audience || '').toLowerCase();
    const ownerScope = String(req.query.owner || '').toLowerCase();

    if (partyId) {
      const identity = await getCurrentIdentity(req, pool);
      try {
        await ensurePartyAudioAccess(partyId, identity);
      } catch (err) {
        if (err?.status) {
          return res
            .status(err.status)
            .json({ ok: false, error: err.message || 'party_access_denied' });
        }
        throw err;
      }
      const rows = await loadTracksForClause('party_id = $1', [partyId], limit);
      const tracks = await serializeTracks(rows);
      return res.json({ ok: true, scope: 'party', party_id: partyId, tracks });
    }

    if (audience === 'trashtalk') {
      const rows = await loadTracksForClause('party_id IS NULL', [], limit);
      const tracks = await serializeTracks(rows);
      return res.json({ ok: true, scope: 'trashtalk', tracks });
    }

    if (ownerScope === 'me') {
      const identity = await getCurrentIdentity(req, pool);
      const memberId =
        identity?.memberId || identity?.member_id || getCurrentMemberId(req);
      if (!memberId) {
        return res.status(401).json({ ok: false, error: 'not_logged_in' });
      }
      const rows = await loadTracksForClause('owner_member_id = $1', [memberId], limit);
      const tracks = await serializeTracks(rows);
      return res.json({ ok: true, scope: 'owner', tracks });
    }

    return res.status(400).json({ ok: false, error: 'missing_scope' });
  } catch (err) {
    console.error('[audio:list] error', err);
    next(err);
  }
});

module.exports = router;
