// api/espn/login.js
// GET  /api/platforms/espn/cred
// POST /api/platforms/espn/cred   (optional body: { swid, s2 })

const express = require('express');
const crypto  = require('crypto');

module.exports = function createEspnCredLinkRouter(pool) {
  const router = express.Router();

  // ---------- cookie helpers ----------
  const COOKIE_DOMAIN = '.fortifiedfantasy.com';
  const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', domain: COOKIE_DOMAIN };

  function readCookiesHeader(header = '') {
    const out = {};
    (header || '').split(/;\s*/).forEach(p => {
      if (!p) return;
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? '' : p.slice(i + 1);
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    });
    return out;
  }

  function normalizeSwid(raw = '') {
    // Accept raw, percent-encoded, with/without braces; output "{XXXXXXXX-...}" uppercase
    const t = String(raw || '').trim();
    if (!t) return '';
    let s;
    try { s = decodeURIComponent(t); } catch { s = t; }
    const m = s.match(/\{?([0-9a-fA-F-]{36})\}?/);
    if (!m) return '';
    return `{${m[1].toUpperCase()}}`;
  }

  function swidToUuidLower(swidBrace) {
    // "{ABCD...}" -> "abcd-..." (for uuid columns)
    return swidBrace ? swidBrace.slice(1, -1).toLowerCase() : '';
  }

  const sha256Hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');

  function makeMemberId() {
    return crypto.randomBytes(8).toString('base64')
      .replace(/[^A-Z0-9]/gi,'').slice(0,8).toUpperCase().padEnd(8,'X');
  }
  function makeSid() { return crypto.randomBytes(24).toString('base64url'); }

  function setFfCookies(res, memberId) {
    // readable flags for FE + an HttpOnly session id
    res.cookie('ff_member_id', memberId, { ...COOKIE_BASE, httpOnly: false, maxAge: 31536000000 });
    res.cookie('ff_logged_in', '1',      { ...COOKIE_BASE, httpOnly: false, maxAge: 31536000000 });
    res.cookie('ff_session_id', makeSid(), COOKIE_BASE);
  }

  function getEspnCookies(req) {
    const c = (req.cookies && Object.keys(req.cookies).length) ? req.cookies : readCookiesHeader(req.headers.cookie || '');
    // prefer common names; support variants
    const swid = c.SWID || c.swid || '';
    const s2   = c.espn_s2 || c.ESPN_S2 || c.espnS2 || '';
    return { swid, s2 };
  }

  // ---------- DB helpers ----------
  async function upsertCred({ swidBrace, s2 }) {
    const swid_hash = sha256Hex(swidBrace);
    const s2_hash   = sha256Hex(s2);
    const { rows } = await pool.query(
      `SELECT cred_id, member_id, s2_hash
         FROM ff_espn_cred
        WHERE swid = $1
        LIMIT 1`,
      [swidBrace]
    );

    if (!rows.length) {
      await pool.query(
        `INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [swidBrace, s2, swid_hash, s2_hash]
      );
      return { created: true, member_id: null };
    }

    const row = rows[0];
    if (row.s2_hash !== s2_hash) {
      await pool.query(
        `UPDATE ff_espn_cred
            SET espn_s2 = $2, s2_hash = $3, last_seen = NOW()
          WHERE swid = $1`,
        [swidBrace, s2, s2_hash]
      );
    } else {
      await pool.query(`UPDATE ff_espn_cred SET last_seen = NOW() WHERE swid = $1`, [swidBrace]);
    }
    return { created: false, member_id: row.member_id || null };
  }

  async function linkViaQuickhitter(swidBrace) {
    const swidUuid = swidToUuidLower(swidBrace);
    const { rows } = await pool.query(
      `
      SELECT *
        FROM ff_quickhitter
       WHERE quick_snap = $1
          OR swid = $2::uuid
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1
      `,
      [swidBrace, swidUuid]
    );
    const row = rows[0];
    if (!row) return { member_id: null, touched: false };

    // backfill uuid swid if missing
    if (!row.swid) {
      await pool.query(`UPDATE ff_quickhitter SET swid=$1::uuid, last_seen_at=NOW() WHERE id=$2`, [swidUuid, row.id]);
    }

    // ensure member_id
    let memberId = (row.member_id || '').trim().toUpperCase();
    if (!memberId) {
      memberId = makeMemberId();
      await pool.query(`UPDATE ff_quickhitter SET member_id=$1, last_seen_at=NOW() WHERE id=$2`, [memberId, row.id]);
    } else {
      await pool.query(`UPDATE ff_quickhitter SET last_seen_at=NOW() WHERE id=$1`, [row.id]);
    }

    return { member_id: memberId, touched: true };
  }

  // ---------- main handler ----------
  async function handle(req, res) {
    try {
      // unify inputs
      let { swid, s2 } = getEspnCookies(req);
      if (!swid || !s2) {
        const b = req.body || {};
        swid = swid || b.swid || b.SWID || '';
        s2   = s2   || b.s2   || b.espn_s2 || '';
      }
      const swidBrace = normalizeSwid(swid);
      if (!swidBrace || !s2) {
        return res.status(401).json({ ok: false, error: 'missing_cookies' });
      }

      // ensure cookies stored in a single, consistent domain
      // clear any duplicates on apex too, then set fresh
      ['SWID', 'ESPN_S2', 'espn_s2'].forEach(n => {
        try { res.clearCookie(n, { ...COOKIE_BASE, domain: COOKIE_DOMAIN }); } catch {}
        try { res.clearCookie(n, { ...COOKIE_BASE, domain: 'fortifiedfantasy.com' }); } catch {}
      });
      res.cookie('SWID', swidBrace, COOKIE_BASE);
      res.cookie('espn_s2', s2,       COOKIE_BASE);

      // 1) upsert cred
      const cred = await upsertCred({ swidBrace, s2 });

      // 2) if cred already linked to a member → log in
      if (cred.member_id) {
        setFfCookies(res, cred.member_id);
        return res.json({ ok: true, step: 'logged_in', member_id: cred.member_id });
      }

      // 3) try to auto-link via quickhitter
      const link = await linkViaQuickhitter(swidBrace);
      if (link.member_id) {
        // write member_id back to cred
        await pool.query(`UPDATE ff_espn_cred SET member_id=$2, last_seen=NOW() WHERE swid=$1`, [swidBrace, link.member_id]);
        setFfCookies(res, link.member_id);
        return res.json({ ok: true, step: 'logged_in', member_id: link.member_id });
      }

      // 4) captured creds but no association yet
      return res.json({ ok: true, step: 'link_needed' });
    } catch (e) {
      console.error('[espn-cred-link] error', e);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  }

  // GET & POST
  router.get('/cred', handle);
  router.post('/cred', express.json({ limit: '256kb' }), handle);

  return router;
};
