// api/identity/session.js
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/** CONFIG */
const ACCESS_TTL_SEC  = 15 * 60;      // 15 min
const REFRESH_TTL_SEC = 90 * 24 * 3600; // 90 days (use 30 if you prefer)
const JWT_SECRET = process.env.JWT_SECRET;   // set in env
const COOKIE_DOMAIN = '.fortifiedfantasy.com'; // <- important
const ISSUER = 'fein-auth';

/** DB helpers (pgsql) */
function sha256(b64){ return crypto.createHash('sha256').update(b64).digest('hex'); }

async function createRefresh(db, { memberId, deviceId, ua, ip, ttlSec }) {
  const token = crypto.randomBytes(48).toString('base64url'); // opaque
  const tokenHash = sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSec * 1000);
  await db.query(
    `INSERT INTO ff_refresh_tokens
      (member_id, token_hash, device_id, user_agent, ip, created_at, last_used_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,now(),now(),$6)`,
    [memberId, tokenHash, deviceId, ua || null, ip || null, expires]
  );
  return token;
}

async function rotateRefresh(db, tokenString) {
  const hash = sha256(tokenString);
  const { rows } = await db.query(
    `DELETE FROM ff_refresh_tokens
      WHERE token_hash = $1
      AND (revoked_at IS NULL) AND (expires_at > now())
      RETURNING member_id, device_id`,
    [hash]
  );
  if (!rows[0]) return null;
  const { member_id, device_id } = rows[0];
  const newTok = await createRefresh(db, {
    memberId: member_id, deviceId: device_id, ttlSec: REFRESH_TTL_SEC
  });
  return { memberId: member_id, deviceId: device_id, refresh: newTok };
}

function signAccess(memberId){
  return jwt.sign(
    { sub: String(memberId) },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL_SEC, issuer: ISSUER }
  );
}

function setAuthCookies(res, { access, refresh, memberId, rememberDays = 90 }) {
  // Access cookie
  res.cookie('ff_at', access, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: ACCESS_TTL_SEC * 1000, path: '/', domain: COOKIE_DOMAIN
  });
  // Refresh cookie (ONLY path-bound to refresh endpoint to reduce CSRF surface)
  if (refresh) {
    res.cookie('ff_rt', refresh, {
      httpOnly: true, secure: true, sameSite: 'strict',
      maxAge: REFRESH_TTL_SEC * 1000, path: '/api/identity/refresh', domain: COOKIE_DOMAIN
    });
  }
  // Optional helper for UI (non-HttpOnly)
  if (memberId) {
    res.cookie('ff_member', String(memberId), {
      httpOnly: false, secure: true, sameSite: 'lax',
      maxAge: rememberDays * 24 * 3600 * 1000, path: '/', domain: COOKIE_DOMAIN
    });
  }
}

// middleware to read access token
function requireAccess(req, res, next){
  const token = req.cookies?.ff_at;
  if (!token) return res.status(401).json({ ok:false, error:'no_access' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: ISSUER });
    req.memberId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ ok:false, error:'bad_access' });
  }
}

module.exports = function createSessionRouter(db){
  const router = express.Router();
  router.use(express.json());

  // 1) After VERIFY-CODE succeeds, issue cookies
  router.post('/verify-code/finish', async (req, res) => {
    // assume you've already validated the submitted code earlier and resolved member_id
    const { member_id, device_id } = req.body || {};
    if (!member_id) return res.status(400).json({ ok:false, error:'member_required' });

    const access = signAccess(member_id);
    const refresh = await createRefresh(db, {
      memberId: member_id,
      deviceId: device_id || crypto.randomUUID(),
      ua: req.get('user-agent'),
      ip: req.headers['cf-connecting-ip'] || req.ip,
      ttlSec: REFRESH_TTL_SEC
    });

    setAuthCookies(res, { access, refresh, memberId: member_id });
    return res.json({ ok:true, member_id });
  });

  // 2) Silent refresh (no body required)
  router.post('/refresh', async (req, res) => {
    const rt = req.cookies?.ff_rt;
    if (!rt) return res.status(401).json({ ok:false, error:'no_refresh' });

    const rotated = await rotateRefresh(db, rt);
    if (!rotated) return res.status(401).json({ ok:false, error:'refresh_invalid' });

    const access = signAccess(rotated.memberId);
    setAuthCookies(res, { access, refresh: rotated.refresh, memberId: rotated.memberId });
    return res.status(204).end();
  });

  // 3) Who am I (checks access cookie only)
  router.get('/whoami', requireAccess, async (req, res) => {
    const { rows } = await db.query(
      `SELECT member_id, handle, primary_email, primary_phone, avatar_url
         FROM ff_member WHERE member_id = $1 LIMIT 1`,
      [req.memberId]
    );
    if (!rows[0]) return res.status(404).json({ ok:false, error:'no_member' });
    return res.json({ ok:true, me: rows[0] });
  });

  // 4) Logout (revoke current device)
  router.post('/logout', async (req, res) => {
    const rt = req.cookies?.ff_rt;
    if (rt) {
      await db.query(
        `UPDATE ff_refresh_tokens SET revoked_at=now()
           WHERE token_hash=$1 AND revoked_at IS NULL`,
        [sha256(rt)]
      );
    }
    // clear cookies
    res.clearCookie('ff_at', { path:'/', domain: COOKIE_DOMAIN });
    res.clearCookie('ff_rt', { path:'/api/identity/refresh', domain: COOKIE_DOMAIN });
    res.clearCookie('ff_member', { path:'/', domain: COOKIE_DOMAIN });
    return res.json({ ok:true });
  });

  return router;
};
