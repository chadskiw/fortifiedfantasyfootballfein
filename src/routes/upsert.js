// src/routes/upsert.js
// Exposes:
//   POST /api/fein-auth/fein/meta/upsert
//   POST /api/identity/handle/upsert
//   POST /api/profile/claim-username     (alias to handle upsert)

const express = require('express');
const router  = express.Router();

const pool = require('../db/pool');
const { upsertFeinMeta } = require('../db/feinMeta');

// ---------- helpers ----------
function readCookiesHeader(header = '') {
  const out = {};
  (header || '').split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}
function normalizeSwid(raw = '') {
  const v = String(raw || '').trim();
  if (!v) return '';
  // ensure {UUID} uppercase
  const s = v.replace(/[{}]/g, '').toUpperCase();
  return `{${s}}`;
}
const HANDLE_RE = /^[A-Za-z0-9_.](?:[A-Za-z0-9_. ]{1,22})[A-Za-z0-9_.]$/; // allow one internal space, no ends
function normHandle(v=''){ const s=String(v).trim().replace(/\s+/g,' '); return HANDLE_RE.test(s) ? s : ''; }

// accept JSON bodies for endpoints below
router.use(express.json({ limit: '1mb' }));

// ===================================================================
// FEIN META UPSERT
// POST /api/fein-auth/fein/meta/upsert
// ===================================================================
router.post('/fein-auth/fein/meta/upsert', async (req, res) => {
  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();

    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swidHdr = req.get('x-espn-swid') || req.body?.swid || cookies.SWID || '';
    const s2Hdr   = req.get('x-espn-s2')   || req.body?.s2   || cookies.espn_s2 || '';

    const swid = normalizeSwid(swidHdr);
    const s2   = decodeURIComponent(String(s2Hdr || '').trim());

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok:false, error:'missing_fields' });
    }
    if (platform !== 'espn') {
      return res.status(400).json({ ok:false, error:'platform_must_be_espn' });
    }
    if (!swid || !s2) {
      return res.status(400).json({ ok:false, error:'missing_espn_creds' });
    }

    const row = await upsertFeinMeta({
      season, platform, league_id, team_id,
      name: null, handle: null, league_size: null, fb_groups: null,
      swid, espn_s2: s2,
    });

    return res.json({ ok:true, row });
  } catch (err) {
    console.error('[fein-meta upsert] error:', {
      message: err?.message, code: err?.code, detail: err?.detail, constraint: err?.constraint,
    });
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ===================================================================
// HANDLE UPSERT (and alias “claim-username”)
// POST /api/identity/handle/upsert
// POST /api/profile/claim-username   (alias)
// ===================================================================
async function upsertHandleCore(req, res) {
  try {
    const memberIdCookie = String(req.cookies?.ff_member || '').trim().toUpperCase();
    const member_id = String(req.body?.member_id || memberIdCookie || '').trim().toUpperCase();
    const handleRaw = String(req.body?.handle || req.body?.username || '').trim();
    const handle    = normHandle(handleRaw);

    // decide how strict you want this — for pre-auth claims, allow body member_id
    if (!member_id) return res.status(401).json({ ok:false, error:'unauthorized' });
    if (!handle)    return res.status(422).json({ ok:false, error:'invalid_handle' });

    // Is handle already used by someone else?
    const taken = await pool.query(
      `SELECT member_id FROM ff_member
        WHERE deleted_at IS NULL AND LOWER(username)=LOWER($1)
        LIMIT 1`,
      [handle]
    );

    if (taken.rows[0] && String(taken.rows[0].member_id).toUpperCase() !== member_id) {
      return res.status(409).json({ ok:false, error:'handle_taken' });
    }

    // Try update member first
    const upd = await pool.query(
      `UPDATE ff_member
          SET username=$1, updated_at=now()
        WHERE member_id=$2 AND deleted_at IS NULL
        RETURNING member_id`,
      [handle, member_id]
    );

    if (upd.rows[0]) {
      return res.json({ ok:true, member_id, username: handle });
    }

    // If member row doesn’t exist yet, create one
    const ins = await pool.query(
      `INSERT INTO ff_member (member_id, username, first_seen_at, last_seen_at, event_count)
       VALUES ($1, $2, now(), now(), 0)
       ON CONFLICT (member_id) DO UPDATE SET username=EXCLUDED.username, updated_at=now()
       RETURNING member_id`,
      [member_id, handle]
    );

    return res.json({ ok:true, member_id: ins.rows[0].member_id, username: handle });
  } catch (e) {
    // unique violation => 23505
    if (String(e.code) === '23505') {
      return res.status(409).json({ ok:false, error:'handle_taken' });
    }
    console.error('[identity handle upsert] error', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

router.post('/identity/handle/upsert', upsertHandleCore);
router.post('/profile/claim-username', upsertHandleCore); // alias

module.exports = router;
