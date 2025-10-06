// TRUE_LOCATION: src/routes/espnAuth.js
// IN_USE: Verify ESPN SWID+S2 against ff_espn_cred; if no member_id exists, create one;
//         then upsert ff_quickhitter by SWID only, set login cookies, and return identity.

const express = require('express');
const crypto = require('crypto');

/** @typedef {import('pg').Pool} Pool */
/** @param {{ db: Pool, cookieDomain?: string }} deps */
module.exports = function espnAuthRouter(deps) {
  const { db, cookieDomain } = deps;
  const router = express.Router();

  // ---------- cookie helpers ----------
  const COOKIE_BASE = { path: '/', secure: true, sameSite: 'lax', httpOnly: false };

  function setCookie(res, name, value, opts = {}) {
    const cfg = { ...COOKIE_BASE, domain: cookieDomain, ...opts };
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (cfg.path) parts.push(`Path=${cfg.path}`);
    if (cfg.domain) parts.push(`Domain=${cfg.domain}`);
    if (cfg.maxAge) parts.push(`Max-Age=${cfg.maxAge}`);
    if (cfg.httpOnly) parts.push(`HttpOnly`);
    if (cfg.secure) parts.push(`Secure`);
    if (cfg.sameSite) parts.push(`SameSite=${cfg.sameSite}`);
    res.append('Set-Cookie', parts.join('; '));
  }

  // ---------- utils ----------
  function parseSWID(raw) {
    if (!raw) return null;
    const m = String(raw).trim().match(/^{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})}?$/);
    return m ? m[1].toLowerCase() : null;
  }

  function sha256Hex(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }

  function looksLikeS2(s2) {
    return typeof s2 === 'string' && s2.length >= 40; // sanity check
  }

  // ---------- verify SWID+S2 against ff_espn_cred ----------
  async function fetchMatchingEspnCred(db, swidUuid, s2Raw) {
    const swidBraced = `{${swidUuid}}`;
    const { rows } = await db.query(
      `SELECT cred_id, swid, espn_s2, swid_hash, s2_hash, member_id
         FROM ff_espn_cred
        WHERE swid = $1
        ORDER BY last_seen DESC
        LIMIT 5;`,
      [swidBraced]
    );
    if (!rows?.length) return null;

    const s2h = sha256Hex(s2Raw);
    for (const r of rows) {
      const byHash  = r.s2_hash && r.s2_hash.toLowerCase() === s2h;
      const byPlain = r.espn_s2 && r.espn_s2 === s2Raw; // you currently store plain too
      if (byHash || byPlain) {
        return { cred_id: r.cred_id, swid: r.swid, member_id: r.member_id || null };
      }
    }
    return null;
  }

  // ---------- POST /api/platforms/espn/link ----------
  // Accepts headers or body/query:
  //   x-espn-swid / swid  |  x-espn-s2 / s2
  router.post('/link', express.json(), async (req, res) => {
    try {
      const swidRaw = req.headers['x-espn-swid'] || req.body?.swid || req.query?.swid;
      const s2Raw  = req.headers['x-espn-s2']   || req.body?.s2   || req.query?.s2;

      const swid = parseSWID(swidRaw);
      if (!swid) return res.status(400).json({ ok:false, error:'invalid_swid' });
      if (!looksLikeS2(s2Raw)) return res.status(400).json({ ok:false, error:'invalid_s2' });

      // 1) Verify against ff_espn_cred
      const cred = await fetchMatchingEspnCred(db, swid, s2Raw);
      if (!cred) return res.status(401).json({ ok:false, error:'espn_cred_not_found_or_mismatch' });

      // 2) Ensure we have a member_id: if ff_espn_cred lacks it, create & bind now
      let memberId = cred.member_id;
      if (!memberId) {
        // 8-char uppercase hex (feel free to swap for your own generator)
        memberId = crypto.randomBytes(4).toString('hex').toUpperCase();

        await db.query(
          `UPDATE ff_espn_cred
              SET member_id = $2, last_seen = now()
            WHERE cred_id = $1
              AND (member_id IS NULL OR member_id = '')
            RETURNING member_id;`,
          [cred.cred_id, memberId]
        );
      }

      // 3) Upsert quickhitter by SWID only, attach member_id (no S2 stored)
      const up = await db.query(
        `SELECT * FROM ff_upsert_quickhitter_swid_only($1::uuid, $2::text);`,
        [swid, memberId]
      );
      const rec = up.rows?.[0];
      if (!rec?.quick_snap) return res.status(500).json({ ok:false, error:'quick_snap_missing' });

      // 4) Establish FF login via cookies (frontend expects these)
      const sid = crypto.randomBytes(12).toString('hex');
      setCookie(res, 'ff_member', rec.quick_snap, { maxAge: 31536000 });   // 1y
      setCookie(res, 'ff_logged_in', '1',         { maxAge: 31536000 });
      setCookie(res, 'ff_sid', sid,               { maxAge: 86400 });      // 1d
      setCookie(res, 'ff_espn_swid', `{${swid}}`, { maxAge: 31536000 });
      setCookie(res, 'ff_espn_s2_present', '1',   { maxAge: 31536000 });

      // 5) Respond (never echo S2)
      return res.json({
        ok: true,
        platform: 'espn',
        swid: `{${swid}}`,
        member: rec.quick_snap,     // your UI uses this as the "member cookie"
        boundMemberId: rec.member_id || null,
        flags: { loggedIn: true, espnLinked: true },
        updatedAt: rec.updated_at
      });
    } catch (err) {
      console.error('espn/link error', err);
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // Optional: quick status ping for the UI
  router.get('/cred', async (req, res) => {
    const swidCookie = req.cookies?.ff_espn_swid || null;
    const member     = req.cookies?.ff_member || null;
    const present    = req.cookies?.ff_espn_s2_present === '1';
    res.json({ ok:true, linked:Boolean(swidCookie && present), member, swid: swidCookie });
  });

  return router;
};
