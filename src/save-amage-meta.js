// src/save-image-meta.js
const { query } = require('../src/db');

async function saveImageMeta({ code, key, etag, format, bytes, page, ua }) {
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
    [code, key, etag || null, (format || 'webp').toLowerCase(), bytes || 0, page || '/', ua || '']
  );
  return up.rows[0]?.member_id || null;
}

module.exports = { saveImageMeta };
