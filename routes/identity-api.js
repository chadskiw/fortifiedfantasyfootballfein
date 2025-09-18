// routes/identity-api.js (request-code)
const express = require('express');
const router = express.Router();
const { query } = require('../src/db');
const { makeCode, ensureInteracted } = require('./identity');

router.post('/request-code', async (req, res) => {
  try {
    const { code } = ensureInteracted(req, res);            // 8-char FFID
    const identifier = String(req.body?.identifier || '').trim() || null;

    const ua = req.get('user-agent') || '';
    const ref = req.get('referer') || req.get('referrer') || null;
    const host = req.get('host');
    const page = req.query.page ? String(req.query.page) : '/';
    const url  = `${req.protocol}://${host}${req.originalUrl}`;

    // 1) (Non-blocking) seed ff_invite if present in your DB, ignore if not
    try {
      await query(`
        INSERT INTO ff_invite (interacted_code, first_identifier, landing_url, user_agent)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (interacted_code) DO NOTHING
      `, [code, identifier, url, ua]);
    } catch (e) {
      // Ignore if table doesn't exist or columns differ
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[identity/request-code] ff_invite insert skipped:', e.message);
      }
    }

    // 2) Generate login code & upsert ff_member (match your schema)
    const loginCode = makeCode(8);

    await query(`
      WITH upsert AS (
        INSERT INTO ff_member (
          interacted_code,
          login_code, login_code_expires,
          last_event_type, last_seen_at,
          first_seen_at,
          first_referrer, last_referrer,
          first_page,     last_page,
          user_agent
        )
        VALUES (
          $1,
          $2, now() + interval '15 minutes',
          'id.entered', now(),
          now(),
          $3, $3,
          $4, $4,
          $5
        )
        ON CONFLICT (interacted_code) DO UPDATE SET
          login_code         = EXCLUDED.login_code,
          login_code_expires = EXCLUDED.login_code_expires,
          last_event_type    = 'id.entered',
          last_seen_at       = now(),
          last_referrer      = COALESCE(EXCLUDED.last_referrer, ff_member.last_referrer),
          last_page          = EXCLUDED.last_page,
          user_agent         = EXCLUDED.user_agent
        RETURNING member_id
      )
      INSERT INTO ff_event (interacted_code, member_id, type, page, user_agent)
      SELECT $1, member_id, 'id.entered', $4, $5 FROM upsert;
    `, [code, loginCode, ref, page, ua]);

    // TODO: send the loginCode via email/SMS to `identifier` (if you want)
    return res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[identity/request-code]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
