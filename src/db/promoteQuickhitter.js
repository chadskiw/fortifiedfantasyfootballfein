// src/db/promoteQuickhitter.js
const pool = require('../db/pool'); // your single Pool module

// Returns { ok, member_id, created, updated }
async function promoteQuickhitterToMember({ member_id, adj1, adj2, noun }) {
  // 1) Read the quickhitter row
  const { rows: qhRows } = await pool.query(
    `SELECT * FROM ff_quickhitter WHERE member_id = $1 LIMIT 1`,
    [member_id]
  );
  const qh = qhRows[0];
  if (!qh) return { ok:false, error:'no_quickhitter' };

  const handle   = (qh.handle || '').trim();
  const email    = (qh.email  || '').trim() || null;
  const phone    = (qh.phone  || '').trim() || null;
  const emailOK  = !!qh.email_is_verified;
  const phoneOK  = !!qh.phone_is_verified;
  const colorHex = (qh.color_hex || '').replace(/^#/,'').toUpperCase() || null;
  const imgKey   = qh.image_key || null;

  // Require: handle AND (verified email OR verified phone)
  if (!handle || !(emailOK || phoneOK)) return { ok:false, error:'not_eligible' };

  // 2) Upsert into ff_member
  const up = await pool.query(
    `
    INSERT INTO ff_member (
      member_id, username, email, phone_e164,
      email_verified_at, phone_verified_at,
      image_key, color_hex,
      first_seen_at, last_seen_at,
      adj1, adj2, noun
    )
    VALUES (
      $1, $2, $3, $4,
      CASE WHEN $5 THEN NOW() ELSE NULL END,
      CASE WHEN $6 THEN NOW() ELSE NULL END,
      $7, $8,
      COALESCE((SELECT first_seen_at FROM ff_member WHERE member_id=$1), NOW()),
      NOW(),
      $9, $10, $11
    )
    ON CONFLICT (member_id) DO UPDATE SET
      username          = COALESCE(EXCLUDED.username, ff_member.username),
      email             = COALESCE(EXCLUDED.email,    ff_member.email),
      phone_e164        = COALESCE(EXCLUDED.phone_e164, ff_member.phone_e164),
      email_verified_at = COALESCE(ff_member.email_verified_at, EXCLUDED.email_verified_at),
      phone_verified_at = COALESCE(ff_member.phone_verified_at, EXCLUDED.phone_verified_at),
      image_key         = COALESCE(EXCLUDED.image_key, ff_member.image_key),
      color_hex         = COALESCE(EXCLUDED.color_hex, ff_member.color_hex),
      last_seen_at      = NOW(),
      adj1              = COALESCE(EXCLUDED.adj1, ff_member.adj1),
      adj2              = COALESCE(EXCLUDED.adj2, ff_member.adj2),
      noun              = COALESCE(EXCLUDED.noun, ff_member.noun)
    RETURNING member_id
    `,
    [
      member_id,
      handle,
      email,
      phone,
      emailOK,
      phoneOK,
      imgKey,
      colorHex,
      adj1 || null,
      adj2 || null,
      noun || null,
    ]
  );

  return { ok:true, member_id: up.rows[0].member_id, created:false, updated:true };
}

module.exports = { promoteQuickhitterToMember };
