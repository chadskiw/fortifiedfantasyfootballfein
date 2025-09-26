// routes/espn/index.js  (only the /link bits shown)
const express = require('express');
const router  = express.Router();

let pool = require('../../src/db/pool');
if (pool && pool.pool && typeof pool.pool.query === 'function') pool = pool.pool;
if (!pool || typeof pool.query !== 'function') throw new Error('[espn] pg pool missing');

// 👉 use your job helper
const { ingestOneFan } = require('../../src/routes/espn-ingest');

// Small helpers
function normalizeSwid(raw) {
  if (!raw) return null;
  const s = decodeURIComponent(String(raw)).toUpperCase();
  return /^\{.*\}$/.test(s) ? s : `{${s.replace(/^\{|\}$/g,'')}}`;
}
function normalizeS2(raw) {
  if (!raw) return null;
  // s2 often arrives with spaces instead of '+' from some encoders
  const s = decodeURIComponent(String(raw)).replace(/ /g, '+');
  return s;
}
async function ensureCredsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_espn_cred (
      swid       TEXT PRIMARY KEY,
      espn_s2    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
async function upsertCred({ swid, s2 }) {
  await pool.query(`
    INSERT INTO ff_espn_cred (swid, espn_s2)
    VALUES ($1,$2)
    ON CONFLICT (swid) DO UPDATE
      SET espn_s2 = EXCLUDED.espn_s2,
          updated_at = now()
  `, [swid, s2 || null]);
}

// Unified handler (works for GET or POST)
async function linkHandler(req, res) {
  try {
    const swid = normalizeSwid(req.body.swid ?? req.query.swid);
    const s2   = normalizeS2(req.body.s2 ?? req.query.s2);
    if (!swid || !s2) return res.status(400).send('missing swid or s2');

    // store creds
    await ensureCredsTable();
    await upsertCred({ swid, s2 });

    // set cookies
    const secure  = process.env.NODE_ENV === 'production';
    const oneYear = 1000 * 60 * 60 * 24 * 365;
    res.cookie('SWID', swid,         { httpOnly:true, sameSite:'Lax', secure, maxAge:oneYear, path:'/' });
    res.cookie('espn_s2', s2,        { httpOnly:true, sameSite:'Lax', secure, maxAge:oneYear, path:'/' });
    res.cookie('fein_has_espn','1',  { httpOnly:false,sameSite:'Lax', secure, maxAge:1000*60*60*24*90, path:'/' });
    res.cookie('ff_espn_swid', swid, { httpOnly:true, sameSite:'Lax', secure, maxAge:oneYear, path:'/' });
    res.cookie('ff_espn_s2',   s2,   { httpOnly:true, sameSite:'Lax', secure, maxAge:oneYear, path:'/' });

    // kick off ingestion (non-blocking)
    ingestOneFan(swid).catch(e => console.error('[espn/link] ingestOneFan failed', e));

    // if you have a broader multi-league job, you can trigger it as well:
    // queueIngestAllSports({ memberId: req.cookies?.ff_member || null, swid, s2 }).catch(console.error);

    // redirect
    const ret = (req.query.to || req.query.return || req.query.next || '/fein').toString();
    return res.redirect(302, ret);
  } catch (e) {
    console.error('[espn/link] error', e);
    res.status(500).send('link_failed');
  }
}
// src/routes/espn/index.js

// replace old readCreds with this async version
async function readCreds(req) {
  const c = req.cookies || {};
  let swid = c.SWID || c.swid || null;
  if (swid) {
    const dec = decodeURIComponent(String(swid));
    swid = /^\{.*\}$/.test(dec) ? dec : `{${dec.replace(/^\{?|\}?$/g,'')}}`;
  }
  let s2 = c.espn_s2 || c.ESPN_S2 || null;

  // fallback to DB if s2 not present in cookies
  if (!s2 && swid) {
    try {
      const { rows } = await pool.query(
        `SELECT espn_s2 FROM ff_espn_cred WHERE LOWER(swid)=LOWER($1) LIMIT 1`,
        [swid]
      );
      s2 = rows[0]?.espn_s2 || null;
    } catch {}
  }
  return { swid, s2 };
}
router.get('/authcheck', (req, res) => {
  const c = req.cookies || {};
  const hasESPN = !!(
    (c.SWID && (c.espn_s2 || c.ESPN_S2)) ||
    (c.ff_espn_swid && c.ff_espn_s2) ||
    c.has_espn === '1' || c.ff_has_espn === '1' || c.fein_has_espn === '1'
  );
  res.set('Cache-Control','no-store');
  res.json({ ok: true, hasESPN });
});

router.get('/link',  linkHandler);
router.post('/link', linkHandler);

module.exports = router;
