// routes/espn/hydrate.js
// Auto-hydrate SWID and espn_s2 cookies for logged-in members,
// and force responses to be cache-busting so Set-Cookie isn't dropped by 304.

const crypto = require('crypto');

const S2_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
});
const SWID_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
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

// Helper: is this request *likely* targeting ESPN routes?
function isEspnPath(p) {
  return typeof p === 'string' && (
    p.startsWith('/api/platforms/espn') ||
    p.startsWith('/api/espn') ||
    p.startsWith('/api/espn-auth')
  );
}

module.exports = function hydrateEspn() {
  return async function hydrateEspnMiddleware(req, res, next) {
    try {
      // Only do lightweight work on idempotent GETs
      if (req.method !== 'GET') return next();

      // Only touch ESPN paths (avoid global no-store)
      if (!isEspnPath(req.path)) return next();

      const pool = req.app.get('pg');
      if (!pool || typeof pool.query !== 'function') return next();

      // Prevent downstream 304 so Set-Cookie survives
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Vary', 'Cookie');

      const c = req.cookies || {};
      const loggedIn = c.ff_logged_in === '1';
      const memberId = (c.ff_member_id || '').trim();
      const sessionId = (c.ff_session_id || '').trim();

      if (!loggedIn || !memberId || !sessionId) return next();

      // Validate session
      const okSess = await pool.query(
        `SELECT 1 FROM ff_session WHERE member_id=$1 AND session_id=$2 LIMIT 1`,
        [memberId, sessionId]
      );
      if (!okSess.rows.length) return next();

      const haveSWID = !!(c.SWID || c.swid);
      const haveS2   = !!(c.espn_s2);

      let swid = haveSWID ? normalizeSwid(c.SWID || c.swid) : null;
      let s2   = haveS2 ? (c.espn_s2 || '') : null;

      // 1) If no SWID, seed from QuickSnap
      if (!swid) {
        const qh = await pool.query(
          `SELECT quick_snap FROM ff_quickhitter WHERE member_id=$1 LIMIT 1`,
          [memberId]
        );
        const qs = (qh.rows[0]?.quick_snap || '').trim();
        if (qs) {
          swid = normalizeSwid(qs);
          res.cookie('SWID', swid, SWID_COOKIE_OPTS);
          if (DEBUG) console.log('[hydrate-espn] set SWID from quick_snap', { memberId });
        }
      }

      // 2) If no S2, pull from DB (member first, fallback swid_hash)
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
          // convenience, non-HttpOnly
          res.cookie('fein_has_espn', '1', { path:'/', sameSite:'Lax', secure:true, httpOnly:false, maxAge: 1000*60*60*24*90 });
          if (DEBUG) console.log('[hydrate-espn] set espn_s2', { memberId, via: swid ? 'swid_hash/db' : 'db(member)' });
        }
      }

      return next();
    } catch (e) {
      if (DEBUG) console.warn('[hydrate-espn] skipped:', e.message);
      return next();
    }
  };
};
