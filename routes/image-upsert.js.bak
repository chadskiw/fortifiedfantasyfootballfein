// routes/image-upsert.js
// Express router for ingesting a raw image and storing it in Cloudflare R2,
// while wiring first-touch + activity state in Postgres.

const express = require('express');
const router = express.Router();

const { query } = require('../src/db');
const { putThumbToR2 } = require('../src/middleware/r2'); // server-side R2 uploader
const { ensureInteracted } = require('./identity');        // sets/reads ff-interacted cookie

// Accept raw image bytes up to ~6 MB
const RAW_LIMIT = '6mb';
const ACCEPTED_IMAGE = /^image\//i;

// POST /api/image/upsert[?page=/somewhere]
router.post(
  '/upsert',
  express.raw({ type: ACCEPTED_IMAGE, limit: RAW_LIMIT }),
  async (req, res) => {
    try {
      // Basic guards
      const contentType = (req.get('content-type') || 'image/webp').toLowerCase();
      if (!ACCEPTED_IMAGE.test(contentType)) {
        return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
      }
      if (!req.body || !req.body.length) {
        return res.status(400).json({ ok: false, error: 'empty_body' });
      }

      // Identity: ensure we have the 8-char ffid cookie/header value
      const { code, source } = ensureInteracted(req, res);
      const isNew = source === 'generated'; // first time we minted it this request

      // Useful request context
      const page = String(req.query.page || '/');
      const ua = req.get('user-agent') || '';
      const landingUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      // 1) Upload to R2 (keyed by ffid partition)
      const { key, etag, url } = await putThumbToR2(req.body, contentType, code);

      // 2) Seed invite record on first touch of this ffid (no overwrite)
      await query(
        `
        INSERT INTO ff_invite (interacted_code, landing_url, user_agent, first_photo_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (interacted_code) DO NOTHING
        `,
        [code, landingUrl, ua, key]
      );

      // 3) Upsert member snapshot + append an event (single round-trip)
      const up = await query(
        `
        WITH ins AS (
          INSERT INTO ff_member (
            interacted_code, image_key, image_etag, image_format,
            image_width, image_height, image_bytes, image_sha256,
            image_version, last_image_at, image_count, event_count,
            last_event_type, last_seen_at, last_page, user_agent
          )
          VALUES (
            $1, $2, $3, $4,
            0, 0, $5, NULL,
            1, now(), 1, 1,
            'image.upsert', now(), $6, $7
          )
          ON CONFLICT (interacted_code) DO UPDATE SET
            image_key       = EXCLUDED.image_key,
            image_etag      = EXCLUDED.image_etag,
            image_format    = EXCLUDED.image_format,
            image_version   = ff_member.image_version + 1,
            last_image_at   = now(),
            image_count     = ff_member.image_count + 1,
            event_count     = ff_member.event_count + 1,
            last_event_type = 'image.upsert',
            last_seen_at    = now(),
            last_page       = EXCLUDED.last_page,
            user_agent      = EXCLUDED.user_agent
          RETURNING member_id
        )
        INSERT INTO ff_event (interacted_code, member_id, type, page, user_agent, r2_key, image_format)
        SELECT $1, member_id, 'image.upsert', $6, $7, $2, $4 FROM ins
        RETURNING member_id
        `,
        [
          code,                // $1 interacted_code
          key,                 // $2 image_key
          etag || null,        // $3 image_etag
          // Normalize format from content-type
          (contentType.split('/')[1] || 'webp').toLowerCase(), // $4 image_format
          Buffer.byteLength(req.body), // $5 image_bytes
          page,                // $6 page
          ua                   // $7 user_agent
        ]
      );

      const memberId = up.rows[0]?.member_id || null;

      // Success response (include url if you configured R2_PUBLIC_BASE)
      return res.json({
        ok: true,
        code,
        isNew,
        memberId,
        key,
        etag: etag || undefined,
        url: url || undefined
      });
    } catch (e) {
      console.error('[image/upsert]', e);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  }
);

module.exports = router;
