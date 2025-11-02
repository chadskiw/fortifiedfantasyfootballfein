// routes/identity/avatar.js
const express = require('express');
const pool = require('../../src/db/pool');
const router = express.Router();

const CDN_BASE = 'https://img.fortifiedfantasy.com';
const AVATAR_PATH = '/avatar/anon';
const DEFAULT_KEY = 'default.png'; // change if your default is different

const SAFE_KEY = /^([a-z0-9_-]{2,64})(?:\.(jpg|jpeg|png|webp))?$/i;

function sanitizeKey(input) {
  if (!input) return '';
  const filename = String(input).trim().split('/').pop(); // last path segment
  const m = filename.match(SAFE_KEY);
  return m ? m[0] : '';
}

function keyFromUrl(u) {
  try {
    const url = new URL(u);
    // prefer …/avatar/anon/<key>
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => p === 'avatar');
    if (idx >= 0 && parts[idx + 1] === 'anon' && parts[idx + 2]) {
      return sanitizeKey(parts[idx + 2]);
    }
    // fallback: last segment
    return sanitizeKey(parts[parts.length - 1] || '');
  } catch {
    // not a URL; treat as a raw key
    return sanitizeKey(u);
  }
}

function cdnUrlFor(key) {
  const safe = sanitizeKey(key) || DEFAULT_KEY;
  return `${CDN_BASE}${AVATAR_PATH}/${encodeURIComponent(safe)}`;
}

function who(req) {
  // Prefer auth middleware; fall back to cookie or query param
  return req.user?.member_id || req.cookies?.ff_member || req.query?.memberId || null;
}

function reply(req, res, memberId, key) {
  const url = cdnUrlFor(key);
  const fmt = String(req.query.format || 'json').toLowerCase();
  if (fmt === 'redirect') {
    res.set('Cache-Control', 'public, max-age=300');
    return res.redirect(302, url);
  }
  if (fmt === 'key') return res.json({ ok: true, key });
  if (fmt === 'url') return res.json({ ok: true, url });
  return res.json({ ok: true, member_id: String(memberId), key, url });
}

/** GET /api/identity/avatar
 *  - ?memberId=<id> (optional; default = current user)
 *  - ?format=key|url|redirect (default: json with both)
 */
router.get('/avatar', async (req, res) => {
  try {
    const memberId = who(req);
    if (!memberId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { rows } = await pool.query(
      'SELECT image_key FROM ff_quickhitter WHERE member_id = $1 LIMIT 1',
      [memberId]
    );

    const key = sanitizeKey(rows?.[0]?.image_key) || DEFAULT_KEY;
    return reply(req, res, memberId, key);
  } catch (e) {
    console.error('[identity.avatar GET]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/** POST /api/identity/avatar
 *  Body: { key?: string, url?: string }
 *  - Stores the sanitized key (basename + optional ext) to ff_quickhitter.image_key
 *  - Returns according to ?format=...
 */
router.post('/avatar', async (req, res) => {
  try {
    const memberId = who(req);
    if (!memberId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const rawKey = req.body?.key ? sanitizeKey(req.body.key)
                 : req.body?.url ? keyFromUrl(req.body.url)
                 : '';
    if (!rawKey) return res.status(400).json({ ok: false, error: 'invalid_key' });

    await pool.query(`
      INSERT INTO ff_quickhitter (member_id, image_key, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (member_id)
      DO UPDATE SET image_key = EXCLUDED.image_key, updated_at = now()
    `, [memberId, rawKey]);

    return reply(req, res, memberId, rawKey);
  } catch (e) {
    console.error('[identity.avatar POST]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
