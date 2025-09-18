const express = require('express');
const router = express.Router();
const { query } = require('../src/lib/db');
const { putThumbToR2 } = require('../src/lib/r2');
const { ensureInteracted } = require('../src/lib/identity');

// raw body for image uploads
router.post('/upsert', express.raw({ type: 'image/*', limit: '6mb' }), async (req, res) => {
  try {
    const { code, isNew } = ensureInteracted(req, res);
    const page = req.query.page || '/';
    const ua = req.get('user-agent') || '';

    // 1) upload to R2
    const { key } = await putThumbToR2(req.body, req.get('content-type') || 'image/webp', code);

    // 2) ensure ff_invite row (first touch)
    await query(`
      INSERT INTO ff_invite (interacted_code, landing_url, user_agent, first_photo_key)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (interacted_code) DO NOTHING
    `, [code, req.protocol + '://' + req.get('host') + req.originalUrl, ua, key]);

    // 3) upsert ff_member snapshot + append ff_event
    const up = await query(`
      WITH ins AS (
        INSERT INTO ff_member (
          interacted_code, image_key, image_etag, image_format,
          image_width, image_height, image_bytes, image_sha256,
          image_version, last_image_at, image_count, event_count,
          last_event_type, last_seen_at, last_page, user_agent
        ) VALUES (
          $1, $2, NULL, 'webp',
          0, 0, 0, NULL,
          1, now(), 1, 1,
          'image.upsert', now(), $3, $4
        )
        ON CONFLICT (interacted_code) DO UPDATE SET
          image_key = EXCLUDED.image_key,
          image_format = EXCLUDED.image_format,
          image_version = ff_member.image_version + 1,
          last_image_at = now(),
          image_count = ff_member.image_count + 1,
          event_count = ff_member.event_count + 1,
          last_event_type = 'image.upsert',
          last_seen_at = now(),
          last_page = EXCLUDED.last_page,
          user_agent = EXCLUDED.user_agent
        RETURNING member_id
      )
      INSERT INTO ff_event (interacted_code, member_id, type, page, user_agent, r2_key, image_format)
      SELECT $1, member_id, 'image.upsert', $3, $4, $2, 'webp' FROM ins
      RETURNING member_id
    `, [code, key, page, ua]);

    res.json({ ok: true, code, isNew, memberId: up.rows[0]?.member_id, key });
  } catch (e) {
    console.error('[image/upsert]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
