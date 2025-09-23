// CommonJS / Express router
// GET /api/platforms/espn/cred   ← reads SWID / espn_s2 cookies, upserts, maybe logs in
// POST /api/platforms/espn/cred  ← same logic, but can also accept { swid, s2 } body (optional)

const express = require('express');
const crypto  = require('crypto');

module.exports = function createEspnCredLinkRouter(pool) {
  const router = express.Router();

  // --- helpers ---
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
    const t = String(raw || '').trim();
    if (!t) return '';
    const v = t.replace(/[{}]/g, '').toUpperCase();
    return `{${v}}`;
  }

  function sha256Hex(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
  }

  async function ensureSession(req, res, memberId) {
    // Simple cookie “session” to match your existing trust check.
    // If you already have a real session system, hook into it here.
    res.cookie('ff_member', String(memberId), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1y
    });
  }

  // unify cookie sources (cookie-parser + raw header)
  function getEspnCookies(req) {
    const c = req.cookies && Object.keys(req.cookies).length ? req.cookies : readCookiesHeader(req.headers.cookie || '');
    const swid = c.SWID || c.swid || '';
    const s2   = c.espn_s2 || c.ESPN_S2 || c.espnS2 || '';
    return { swid, s2 };
  }

  async function handle(req, res) {
    try {
      // Prefer cookies; allow body override (POST) for testing/tools
      let { swid, s2 } = getEspnCookies(req);
      if (!swid || !s2) {
        const b = req.body || {};
        swid = swid || b.swid || b.SWID || '';
        s2   = s2   || b.s2   || b.espn_s2 || '';
      }

      if (!swid || !s2) {
        return res.status(401).json({ ok: false, error: 'missing_cookies' });
      }

      const swid_norm = normalizeSwid(swid);
      const swid_hash = sha256Hex(swid_norm);
      const s2_hash   = sha256Hex(s2);

      // 1) find existing by SWID
      const { rows } = await pool.query(
        `SELECT cred_id, member_id, espn_s2, s2_hash
           FROM ff_espn_cred
          WHERE swid = $1
          LIMIT 1`,
        [swid_norm]
      );

      if (rows.length === 0) {
        // insert new cred record
        await pool.query(
          `INSERT INTO ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, now(), now())`,
          [swid_norm, s2, swid_hash, s2_hash]
        );
        return res.json({ ok: true, step: 'link_needed' });
      }

      // 2) update s2 if changed; always touch last_seen
      const row = rows[0];
      if (row.s2_hash !== s2_hash) {
        await pool.query(
          `UPDATE ff_espn_cred
              SET espn_s2 = $2, s2_hash = $3, last_seen = now()
            WHERE swid = $1`,
          [swid_norm, s2, s2_hash]
        );
      } else {
        await pool.query(`UPDATE ff_espn_cred SET last_seen = now() WHERE swid = $1`, [swid_norm]);
      }

      // 3) if linked to a member → set ff_member cookie and return logged_in
      if (row.member_id) {
        await ensureSession(req, res, row.member_id);
        return res.json({ ok: true, step: 'logged_in', member_id: row.member_id });
      }

      // not linked yet → client should prompt for handle/email/phone and attach member_id later
      return res.json({ ok: true, step: 'link_needed' });
    } catch (e) {
      console.error('[espn-cred-link] error', e);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  }

  // GET & POST variants
  router.get('/cred', handle);
  router.post('/cred', express.json({ limit: '256kb' }), handle);

  return router;
};
