const express = require('express');
const router = express.Router();
const { query } = require('../src/db');
const { makeCode, ensureInteracted } = require('./identity');

router.post('/request-code', async (req, res) => {
  try {
    const { code } = ensureInteracted(req, res);
    const identifier = String(req.body?.identifier || '').trim();
    const url = req.protocol + '://' + req.get('host') + req.originalUrl;
    const ua = req.get('user-agent') || '';

    // seed invite if missing
    await query(`
      INSERT INTO ff_invite (interacted_code, first_identifier, landing_url, user_agent)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (interacted_code) DO NOTHING
    `, [code, identifier || null, url, ua]);

    // set login_code on ff_member
    const loginCode = makeCode(8);
    await query(`
      INSERT INTO ff_member (interacted_code, login_code, login_code_expires, last_event_type, last_seen_at)
      VALUES ($1, $2, now() + interval '15 minutes', 'id.entered', now())
      ON CONFLICT (interacted_code) DO UPDATE SET
        login_code = EXCLUDED.login_code,
        login_code_expires = EXCLUDED.login_code_expires,
        last_event_type = 'id.entered',
        last_seen_at = now()
    `, [code, loginCode]);

    // TODO: dispatch email/SMS with loginCode
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[identity/request-code]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { code } = ensureInteracted(req, res);
    const submitted = String(req.body?.code || '').trim();

    // validate login code
    const m = await query(`SELECT member_id, login_code, login_code_expires FROM ff_member WHERE interacted_code=$1`, [code]);
    const row = m.rows[0];
    if (!row || row.login_code !== submitted || (row.login_code_expires && new Date(row.login_code_expires) < new Date())) {
      return res.status(400).json({ ok: false, error: 'invalid_or_expired' });
    }

    // stamp verified + link invite -> member + joined_at
    const link = await query(`
      WITH upd_member AS (
        UPDATE ff_member
        SET auth_verified_at = now(), login_code = NULL, last_event_type = 'join.verify', last_seen_at = now()
        WHERE interacted_code = $1
        RETURNING member_id
      )
      UPDATE ff_invite i
      SET member_id = u.member_id,
          joined_at = COALESCE(i.joined_at, now())
      FROM upd_member u
      WHERE i.interacted_code = $1
      RETURNING u.member_id, i.joined_at
    `, [code]);

    // event
    await query(`INSERT INTO ff_event (interacted_code, member_id, type) VALUES ($1, $2, 'verify.click')`,
      [code, link.rows[0]?.member_id || row.member_id]);

    res.json({ ok: true, memberId: link.rows[0]?.member_id || row.member_id });
  } catch (e) {
    console.error('[identity/verify]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
