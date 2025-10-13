// routes/espn/link.js
const crypto = require('crypto');
const express2 = require('express');
const linkRouter = express2.Router();

function sha256(x){return crypto.createHash('sha256').update(String(x)).digest('hex');}
function memberFromCookies(req){return req.cookies?.ff_member_id || null;}

function absoluteOrigin2(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}

// GET /api/platforms/espn/link?swid=...&s2=...&to=/fein/?season=2025
linkRouter.get('/link', async (req, res) => {
  try {
    const SWID_RE = /^\{[0-9A-F-]{36}\}$/i;
    const swid = String(req.query.swid || req.query.SWID || '').trim();
    const s2   = String(req.query.espn_s2 || req.query.ESPN_S2 || req.query.s2 || '').trim();

    // season target + redirect
    const yr     = Number(req.query.season) || new Date().getUTCFullYear();
    const to     = String(req.query.to || `${absoluteOrigin2(req)}/fein/?season=${yr}`);
    const origin = absoluteOrigin2(req);

    // --- set browser cookies (both canonical + compat aliases) ---
    const oneYear = 31536000000;
    const cookieOpts = { httpOnly:true, sameSite:'Lax', secure:true, maxAge:oneYear, domain:'fortifiedfantasy.com', path:'/' };
    if (swid) res.cookie('SWID',    swid, cookieOpts);
    if (s2)   res.cookie('espn_s2', s2,   cookieOpts);

    // FE-readable convenience (optional)
    res.cookie('ff_logged_in', '1', { httpOnly:false, sameSite:'Lax', secure:true, maxAge:oneYear });

    // --- persist creds so server-side requests have them later ---
    // only if we know who the member is
    const pool = req.app.get('pg');
    const member_id = memberFromCookies(req);
    if (pool && member_id && swid) {
      const swid_hash = sha256(swid);
      const s2_hash   = s2 ? sha256(s2) : null;

await pool.query(`
  INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
  VALUES ($1,$2, encode(digest($1,'sha256'),'hex'), NULLIF(encode(digest($2,'sha256'),'hex'),''), $3, now(), now(), $4)
  ON CONFLICT (swid_hash) DO UPDATE
    SET espn_s2  = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
        s2_hash  = COALESCE(EXCLUDED.s2_hash, ff_espn_cred.s2_hash),
        member_id= COALESCE(ff_espn_cred.member_id, EXCLUDED.member_id),
        last_seen= now(),
        ref      = EXCLUDED.ref;
`, [canonicalSwid, rawS2, memberId, 'link']);


      // also backfill quick_snap if empty
      await pool.query(`
        UPDATE ff_quickhitter
           SET quick_snap = COALESCE(quick_snap, $2),
               updated_at = now()
         WHERE member_id = $1
      `, [member_id, swid]);
    }

    // --- kick off + AWAIT season ingest (so data exists on arrival) ---
    // (You can pass a filter like &games=ffl to ingest only football; see next section)
    const headers = { 'x-espn-swid': swid, 'x-espn-s2': s2, 'accept': 'application/json' };
    // Optionally restrict to football if query param provided
    const qsGames = req.query.games ? `&games=${encodeURIComponent(req.query.games)}` : '';
    await fetch(`${origin}/api/ingest/espn/fan/season?season=${yr}${qsGames}`, { method:'POST', headers });

    // --- go to FEIN ---
    return res.redirect(302, to);
  } catch (e) {
    console.error('[espn/link]', e);
    const yr = new Date().getUTCFullYear();
    return res.redirect(302, `/fein/?season=${yr}`);
  }
});

module.exports = linkRouter;
