// routes/platforms/espn/index.js
const express = require('express');
const router  = express.Router();

let db;
try { db = require('../../src/db/pool'); } catch { db = require('../../src/db/pool'); }
const pool = db.pool || db;

// Helpers
const sha256 = s => require('crypto').createHash('sha256').update(String(s)).digest('hex');
const SWID_RE = /^\{[0-9A-Fa-f-]{36}\}$/;

function memberFromCookies(req){
  const c = req.cookies || {};
  return (c.ff_member_id || c.ff_member || '').trim() || null;
}

/**
 * GET /api/platforms/espn/cred
 * Very small “am I linked?” probe — true if we have any row for this member.
 */
router.get('/cred', async (req,res)=>{
  const member_id = memberFromCookies(req);
  if (!member_id) return res.json({ ok:true, linked:false });

  const q = `
    SELECT 1
      FROM ff_espn_cred
     WHERE member_id = $1
     LIMIT 1
  `;
  const { rows } = await pool.query(q, [member_id]);
  res.json({ ok:true, linked: rows.length > 0 });
});

/**
 * GET /api/platforms/espn/link-status
 * Drives the UI: are we “linked”, and what do we have?
 * linked = true if quick_snap has an ESPN-style SWID OR creds row exists.
 */
router.get('/link-status', async (req,res)=>{
  const member_id = memberFromCookies(req);
  if (!member_id) return res.json({ ok:true, linked:false });

  const sql = `
    WITH q AS (
      SELECT quick_snap
        FROM ff_quickhitter
       WHERE member_id = $1
       LIMIT 1
    ),
    c AS (
      SELECT swid, espn_s2
        FROM ff_espn_cred
       WHERE member_id = $1
       ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
       LIMIT 1
    )
    SELECT
      (SELECT quick_snap FROM q)        AS quick_snap,
      (SELECT swid       FROM c)        AS swid,
      (SELECT espn_s2    FROM c)        AS espn_s2
  `;
  const { rows } = await pool.query(sql, [member_id]);
  const row = rows[0] || {};
  const swid = row.swid || row.quick_snap || null;
  const hasValidSwid = !!(swid && SWID_RE.test(String(swid)));
  const hasS2 = !!row.espn_s2;

  res.json({
    ok: true,
    linked: hasValidSwid || hasS2,
    swid: hasValidSwid ? String(swid) : null,
    hasS2,
  });
});

/**
 * GET /api/espn/link
 * (Already live via your bookmarklet.) We keep it very tolerant:
 * - Upserts ff_espn_cred for the member
 * - If member has no quick_snap, fills it with the SWID
 * - Redirects back to ?to=… (or /fein)
 */
router.get('/../../espn/link', async (req, res) => {
  try {
    const member_id = memberFromCookies(req);
    const swid = String(req.query.swid || '').trim();
    const s2   = String(req.query.s2   || '').trim();
    const ret  = String(req.query.to   || '/fein').trim() || '/fein';

    if (!member_id) return res.redirect(ret);
    if (!SWID_RE.test(swid)) return res.redirect(ret);

    const swid_hash = sha256(swid);
    const s2_hash   = s2 ? sha256(s2) : null;

    await pool.query(`
      INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
      VALUES ($1,$2,$3,$4,$5, now(), now(), 'link')
      ON CONFLICT (swid_hash) DO UPDATE
         SET espn_s2  = COALESCE(EXCLUDED.espn_s2, ff_espn_cred.espn_s2),
             s2_hash  = COALESCE(EXCLUDED.s2_hash, ff_espn_cred.s2_hash),
             member_id= COALESCE(ff_espn_cred.member_id, EXCLUDED.member_id),
             last_seen= now()
    `, [swid, s2 || null, swid_hash, s2_hash, member_id]);

    // If member’s quickhitter lacks quick_snap, set it to SWID
    await pool.query(`
      UPDATE ff_quickhitter
         SET quick_snap = COALESCE(quick_snap, $2),
             updated_at = now()
       WHERE member_id = $1
    `, [member_id, swid]);

    res.redirect(ret);
  } catch (e) {
    console.error('[espn/link]', e);
    res.redirect(String(req.query.to || '/fein'));
  }
});

/**
 * (Compatibility) POST /api/platforms/espn/ingest/espn/fan
 * Old endpoint some client code still calls. We no-op it so the console is clean.
 * Return 200 with a tiny body telling the front-end to rely on link-status instead.
 */
router.post('/ingest/espn/fan', (req,res)=>{
  res.json({ ok:true, deprecated:true, use:'link-status' });
});

/**
 * Optional: a tiny /poll that just proxies link-status so the UI can poll safely.
 */
router.get('/poll', async (req,res)=>{
  req.url = '/link-status';
  router.handle(req, res);
});

module.exports = router;
