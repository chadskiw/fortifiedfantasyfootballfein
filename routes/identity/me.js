// routes/identity/me.js
// GET /api/identity/me
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const poolMod = require('../../src/db/pool');
const pool    = poolMod.pool || poolMod;

const cookies = require('../../lib/cookies'); // make sure these set *_id names

const norm = v => (v == null ? '' : String(v)).trim();
const makeSid = () => crypto.randomUUID(); // RFC4122
const MID_RE = /^[A-Z0-9]{8}$/;

function normalizeSwid(raw) {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(String(raw));
    const m = decoded.match(/\{?([0-9a-fA-F-]{36})\}?/);
    if (!m) return null;
    return `{${m[1].toUpperCase()}}`;
  } catch { return null; }
}

function ensureMemberId(v) {
  const clean = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (MID_RE.test(clean)) return clean;
  return crypto.randomBytes(8).toString('base64')
    .replace(/[^A-Z0-9]/gi, '').slice(0,8).toUpperCase().padEnd(8,'X');
}

async function ensureDbSession(sessionId, memberId) {
  if (!sessionId || !memberId) return null;
  await pool.query(
    `INSERT INTO ff_session (session_id, member_id, created_at)
     VALUES ($1, $2, now())
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, memberId]
  );
  return sessionId;
}

async function findOrCreateMemberFromSwid(swidBrace) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();

  const { rows } = await pool.query(
    `SELECT id, member_id, swid, quick_snap
       FROM ff_quickhitter
      WHERE swid = $1::uuid OR quick_snap = $2
      ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [swidUuid, swidBrace]
  );

  if (rows.length) {
    const row = rows[0];
    const memberId = ensureMemberId(row.member_id);
    await pool.query(
      `UPDATE ff_quickhitter
          SET member_id   = $1,
              swid         = $2::uuid,
              quick_snap   = $3,
              last_seen_at = now()
        WHERE id = $4`,
      [memberId, swidUuid, swidBrace, row.id]
    );
    return memberId;
  }

  const memberId = ensureMemberId();
  await pool.query(
    `INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
     VALUES ($1, $2, $3::uuid, now(), now())`,
    [memberId, swidBrace, swidUuid]
  );
  return memberId;
}

async function upsertEspnCred({ swidBrace, s2 }) {
  const swidUuid = swidBrace.slice(1, -1).toLowerCase();
  await pool.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, last_seen)
     VALUES ($1::uuid, NULLIF($2,'') , now())
     ON CONFLICT (swid)
     DO UPDATE SET espn_s2 = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
                   last_seen = now()`,
    [swidUuid, s2 || null]
  );
}

function fireIngest(req, { swidBrace, s2, memberId }) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-espn-swid': swidBrace,
        'x-espn-s2'  : s2 || '',
        'x-fein-key' : memberId || ''
      },
      keepalive: true
    }).catch(() => {});
  } catch {}
}

router.get('/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); res.removeHeader('ETag');

    const midCookie = (req.cookies?.ff_member_id || req.cookies?.ff_member || '').trim();
    const sidCookie = (req.cookies?.ff_session_id || req.cookies?.ff_session || '').trim();
    if (midCookie && sidCookie) {
      await ensureDbSession(sidCookie, midCookie); // idempotent
      return res.status(200).json({ ok:true, member_id: midCookie });
    }

    // ... ESPN self-heal branch ...
    return res.status(200).json({ ok:true, member_id: null });
  } catch (e) {
    return res.status(200).json({ ok:true, member_id: null });
  }
});

function requireMember(req, res, next) {
  // accept cookie first, then header/body/query fallbacks
  const mid =
    (req.cookies?.ff_member_id ||
     req.get('x-member-id') ||
     req.body?.memberId ||
     req.query?.memberId || '')
    .toString().trim().toUpperCase();

  if (!/^[A-Z0-9]{8}$/.test(mid)) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  req.member_id = mid;
  next();
}

// keep exporting the router, but also export the middleware
module.exports = router;
module.exports.requireMember = requireMember;
