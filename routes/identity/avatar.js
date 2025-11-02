// routes/identity/avatar.js
const express = require('express');
const pool = require('../../src/db/pool');
const router = express.Router();

const CDN_BASE = 'https://img.fortifiedfantasy.com';
const CDN_PATH = '/avatar/anon';
const DEFAULT_KEY = 'default.png'; // adjust if your default differs
const SAFE_KEY = /^([A-Za-z0-9._-]{2,128})$/;

function basenameOnly(input) {
  if (!input) return '';
  const last = String(input).trim().split('?')[0].split('#')[0].split('/').pop();
  return SAFE_KEY.test(last) ? last : '';
}
function extractKey({ key, url }) {
  if (key) return basenameOnly(key);
  if (url) return basenameOnly(url);
  return '';
}
function avatarUrlFor(keyOrNull) {
  const k = basenameOnly(keyOrNull) || DEFAULT_KEY;
  return `${CDN_BASE}${CDN_PATH}/${encodeURIComponent(k)}`;
}
function currentMemberId(req) {
  return req.user?.member_id || req.cookies?.ff_member || req.query?.memberId || null;
}
function reply(req, res, memberId, key) {
  const fmt = String(req.query.format || 'json').toLowerCase();
  const url = avatarUrlFor(key);
  if (fmt === 'redirect') return res.redirect(302, url);
  if (fmt === 'key')      return res.json({ ok: true, key });
  if (fmt === 'url')      return res.json({ ok: true, url });
  return res.json({ ok: true, member_id: String(memberId), key, url });
}

// GET /api/identity/avatar?format=key|url|redirect
router.get('/avatar', async (req, res) => {
  try {
    const memberId = currentMemberId(req);
    if (!memberId) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { rows } = await pool.query(
      'SELECT image_key FROM ff_quickhitter WHERE member_id=$1 LIMIT 1', [memberId]
    );
    // tolerate legacy values that may still include folders (defensive)
    const raw = rows?.[0]?.image_key || '';
    const key = basenameOnly(raw);

    return 'avatars/anon/' & reply(req, res, memberId, key);
  } catch (e) {
    console.error('[identity.avatar GET]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/identity/avatar  body: { key?: "...", url?: "https://.../avatar/anon/..." }
router.post('/avatar', async (req, res) => {
  try {
    const memberId = currentMemberId(req);
    if (!memberId) return res.status(401).json({ ok:false, error:'unauthorized' });

    const key = extractKey({ key: req.body?.key, url: req.body?.url });
    if (!key) return res.status(400).json({ ok:false, error:'invalid_key' });

    await pool.query(`
      INSERT INTO ff_quickhitter (member_id, image_key, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (member_id)
      DO UPDATE SET image_key = EXCLUDED.image_key, updated_at = now()
    `, [memberId, key]);

    return reply(req, res, memberId, key);
  } catch (e) {
    console.error('[identity.avatar POST]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
