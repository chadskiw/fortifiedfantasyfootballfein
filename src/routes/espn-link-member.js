// server/routes/espn-link-member.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

// body parsers (same style as your sample)
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// preflight (avoid 405 on OPTIONS)
router.options('/espn/link-member', (_req, res) => res.sendStatus(204));

// DB (reuses the Pool exported by server.js)
const { pool } = require('../server');

// ---------------- helpers ----------------
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

const norm      = (v='') => String(v).trim();
const isEmail   = v => EMAIL_RE.test(norm(v));
const isPhone   = v => PHONE_RE.test(norm(v));
const isHandle  = v => HANDLE_RE.test(norm(v));

const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normSwid  = (s='') => {
  const t = String(s).trim().toUpperCase().replace(/[{}]/g,'');
  return t ? `{${t}}` : '';
};

function getCreds(req){
  const c = req.cookies || {};
  const swid = c.SWID || c.swid || req.get('x-espn-swid') || '';
  const s2   = c.espn_s2 || c.ESPN_S2 || req.get('x-espn-s2') || '';
  return { swid: normSwid(swid), s2: String(s2) };
}

async function lookupMemberIdByIdentifier(identifier){
  const raw = norm(identifier || '');
  if (!raw) return null;

  if (isEmail(raw)) {
    const r = await pool.query(`SELECT member_id FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`, [normEmail(raw)]);
    return r.rows[0]?.member_id || null;
  }
  if (isPhone(raw)) {
    const r = await pool.query(`SELECT member_id FROM ff_member WHERE phone_e164=$1 LIMIT 1`, [normPhone(raw)]);
    return r.rows[0]?.member_id || null;
  }
  if (isHandle(raw)) {
    const r = await pool.query(`SELECT member_id FROM ff_member WHERE LOWER(username)=LOWER($1) LIMIT 1`, [raw]);
    return r.rows[0]?.member_id || null;
  }
  return null;
}

// --------------- POST /api/espn/link-member ---------------
router.post('/espn/link-member', async (req, res) => {
  try {
    const { swid, s2 } = getCreds(req);
    if (!swid || !s2) return res.status(401).json({ ok:false, error:'missing_cookies' });

    let { memberId, identifier } = req.body || {};
    if (!memberId && identifier) memberId = await lookupMemberIdByIdentifier(identifier);
    if (!memberId) return res.status(400).json({ ok:false, step:'signup', prefill: identifier || '' });

    // normalize id to text for safety (your ff_member.member_id is text-like)
    memberId = String(memberId);

    const swid_hash = sha256Hex(swid);
    const s2_hash   = sha256Hex(s2);

    // Upsert cred row and read linkage
    const up = await pool.query(
      `
      INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
      VALUES ($1,$2,$3,$4, now(), now())
      ON CONFLICT (swid) DO UPDATE
        SET espn_s2 = EXCLUDED.espn_s2,
            s2_hash = EXCLUDED.s2_hash,
            last_seen = now()
      RETURNING cred_id, swid, member_id, ghost_member_id
      `,
      [swid, s2, swid_hash, s2_hash]
    );
    const cred = up.rows[0];

    // If this member is already linked to a different SWID → block + ghost
    const other = await pool.query(
      `SELECT swid FROM ff_espn_cred WHERE member_id=$1 AND swid<>$2 LIMIT 1`,
      [memberId, swid]
    );
    if (other.rows[0]) {
      if (!cred.ghost_member_id) {
        await pool.query(
          `UPDATE ff_espn_cred SET ghost_member_id=$2, last_seen=now() WHERE cred_id=$1`,
          [cred.cred_id, memberId]
        );
      }
      return res.status(409).json({
        ok:false,
        error:'member_linked_to_other_swid',
        other_swid: other.rows[0].swid,
        ghost_member_id: memberId
      });
    }

    // Same member already linked → success
    if (cred.member_id && String(cred.member_id) === memberId) {
      return res.json({ ok:true, step:'linked', member_id: memberId });
    }

    // Linked to someone else → no multi-account; ghost this viewer
    if (cred.member_id && String(cred.member_id) !== memberId) {
      if (!cred.ghost_member_id) {
        await pool.query(
          `UPDATE ff_espn_cred SET ghost_member_id=$2, last_seen=now() WHERE cred_id=$1`,
          [cred.cred_id, memberId]
        );
      }
      return res.status(409).json({ ok:false, error:'multi_account_not_supported', ghost_member_id: memberId });
    }

    // Not linked yet → bind it
    await pool.query(
      `UPDATE ff_espn_cred SET member_id=$2, last_seen=now() WHERE cred_id=$1`,
      [cred.cred_id, memberId]
    );

    return res.json({ ok:true, step:'linked', member_id: memberId });
  } catch (e) {
    console.error('[POST /api/espn/link-member]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
