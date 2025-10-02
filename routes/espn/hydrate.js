// src/middleware/hydrate-espn.js
// Auto-hydrate SWID and espn_s2 cookies for logged-in members.
// Preconditions: cookie-parser mounted; app.set('pg', pool) set on the app.

const crypto = require('crypto');

const S2_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
});
const SWID_COOKIE_OPTS = Object.freeze({
  httpOnly: true,   // keep SWID HttpOnly as well; flip to false if you need FE reads
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
});

const DEBUG = process.env.FF_DEBUG_ESPN === '1';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}
function normalizeSwid(raw) {
  if (!raw) return null;
  let s = String(raw);
  try { s = decodeURIComponent(s); } catch {}
  s = s.trim().replace(/^\{|\}$/g, '').toUpperCase();
  return `{${s}}`;
}

module.exports = function hydrateEspn() {
  return async function hydrateEspnMiddleware(req, res, next) {
    try {
      // only do lightweight hydration on idempotent GETs
      if (req.method !== 'GET') return next();

      const pool = req.app.get('pg');
      if (!pool || typeof pool.query !== 'function') return next();

      const c = req.cookies || {};
      const loggedIn = c.ff_logged_in === '1';
      const memberId = (c.ff_member_id || '').trim();
      const sessionId = (c.ff_session_id || '').trim();

      if (!loggedIn || !memberId || !sessionId) return next();

      // Validate the member session so we don't hydrate for spoofed cookies
      const okSess = await pool.query(
        `SELECT 1 FROM ff_session WHERE member_id=$1 AND session_id=$2 LIMIT 1`,
        [memberId, sessionId]
      );
      if (!okSess.rows.length) return next();

      // Decide what we need to hydrate
      const haveSWID = !!(c.SWID || c.swid);
      const haveS2   = !!(c.espn_s2);

      let swid = haveSWID ? normalizeSwid(c.SWID || c.swid) : null;
      let s2   = haveS2 ? (c.espn_s2 || '') : null;

      // 1) If we don't have SWID, try member's QuickSnap
      if (!swid) {
        const qh = await pool.query(
          `SELECT quick_snap FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
          [memberId]
        );
        const qs = (qh.rows[0]?.quick_snap || '').trim();
        if (qs) {
          swid = normalizeSwid(qs);
          res.cookie('SWID', swid, SWID_COOKIE_OPTS);
          if (DEBUG) console.log('[hydrate-espn] set SWID from quick_snap for', memberId);
        }
      }

      // 2) If we don't have s2, look it up for this member
      if (!s2) {
        const cred = await pool.query(
          `SELECT espn_s2 FROM ff_espn_cred
            WHERE member_id=$1
            ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
            LIMIT 1`,
          [memberId]
        );
        s2 = (cred.rows[0]?.espn_s2 || '').trim() || null;
        if (!s2 && swid) {
          // fallback: by swid_hash if member row didn't have s2 yet
          const h = sha256(swid);
          const byHash = await pool.query(
            `SELECT espn_s2 FROM ff_espn_cred
              WHERE swid_hash=$1
              ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
              LIMIT 1`,
            [h]
          );
          s2 = (byHash.rows[0]?.espn_s2 || '').trim() || null;
        }
        if (s2) {
          res.cookie('espn_s2', s2, S2_COOKIE_OPTS);
          // convenience signal for FE (non-HttpOnly)
          res.cookie('fein_has_espn', '1', { path:'/', sameSite:'Lax', secure:true, httpOnly:false, maxAge: 1000*60*60*24*90 });
          if (DEBUG) console.log('[hydrate-espn] set espn_s2 for', memberId, 'source=', swid ? 'swid/db' : 'db(member)');
        }
      }

      return next();
    } catch (e) {
      if (DEBUG) console.warn('[hydrate-espn] skipped:', e.message);
      return next();
    }
  };
};
