// routes/identity/me.js
// Identity probe that "self-heals" login:
// - If ff_* cookies exist -> return member.
// - Else, if ESPN SWID + espn_s2 exist -> create/find member, mint session cookies, fire ingest.
// - Else -> anonymous.
//
// Mount in server: app.use('/api/identity', require('./routes/identity/me'));

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const poolMod = require('../../src/db/pool');
const pool    = poolMod.pool || poolMod;

const cookies = require('../../src/lib/cookies'); // your centralized cookie helpers

// ---------------- utils ----------------

const norm = v => (v == null ? '' : String(v)).trim();
const makeSid = () => crypto.randomBytes(24).toString('base64url');
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
  return crypto.randomBytes(8)
    .toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase()
    .padEnd(8, 'X');
}

async function ensureDbSession(sessionId, memberId) {
  await pool.query(
    `INSERT INTO ff_session (session_id, member_id, created_at)
     VALUES ($1,$2,now())
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, memberId]
  );
  return sessionId;
}

// Find or create a member bound to this SWID using ff_quickhitter.
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
    // Backfill & touch
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

  // Create a new quickhitter row with a fresh member_id.
  const memberId = ensureMemberId();
  await pool.query(
    `INSERT INTO ff_quickhitter (member_id, quick_snap, swid, last_seen_at, created_at)
     VALUES ($1, $2, $3::uuid, now(), now())`,
    [memberId, swidBrace, swidUuid]
  );
  return memberId;
}

// Persist/refresh the ESPN cred record so S2 is tracked.
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

// Fire-and-forget ingest call (must not block).
function fireIngest(req, { swidBrace, s2, memberId }) {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    fetch(`${origin}/api/platforms/espn/ingest/espn/fan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Optional pass-through headers
        'x-espn-swid': swidBrace,
        'x-espn-s2'  : s2 || '',
        'x-fein-key' : memberId || ''
      },
      keepalive: true
    }).catch(() => {});
  } catch {}
}

// ---------------- GET /api/identity/me ----------------

router.get('/me', async (req, res) => {
  try {
    // Kill caching to avoid 304s from CDNs / proxies.
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.removeHeader('ETag');

    // If app cookies already exist, return them.
    const sid = norm(req.cookies?.ff_sid);
    const mid = norm(req.cookies?.ff_member);
    if (sid && mid) {
      return res.status(200).json({ ok: true, member_id: mid });
    }

    // Self-heal: if ESPN cookies exist, log the user in now.
    const swidBrace = normalizeSwid(req.cookies?.SWID);
    const s2        = norm(req.cookies?.espn_s2 || req.cookies?.ESPN_S2);

    if (swidBrace && s2) {
      // Make sure we store/refresh the cred (tracks latest S2).
      await upsertEspnCred({ swidBrace, s2 });

      // Find or create a member for this SWID.
      const memberId = await findOrCreateMemberFromSwid(swidBrace);

      // Create a session and set first-party cookies via your cookie helpers.
      const newSid = await ensureDbSession(makeSid(), memberId);
      cookies.setSessionCookie(res, newSid);  // HttpOnly ff_sid (domain/samesite/secure from lib)
      cookies.setMemberCookie(res, memberId); // readable ff_member for UI

      // Optional: if you don’t want to keep espn_s2 on your domain:
      // cookies.clearEspnS2(res);

      // Kick ingest.
      fireIngest(req, { swidBrace, s2, memberId });

      return res.status(200).json({ ok: true, member_id: memberId });
    }

    // Anonymous
    return res.status(200).json({ ok: true, member_id: null });
  } catch (e) {
    console.error('[identity/me] error', e);
    // Return anonymous (don’t 500 your FE).
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, member_id: null });
  }
});

module.exports = router;
