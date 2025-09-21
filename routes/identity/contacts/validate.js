// POST routes\identity\contacts\validate.js
router.post('/contacts/validate', async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || '').trim().toLowerCase();
    const rawPhone = String(req.body?.phone || '').trim().replace(/[^\d+]/g,'');
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
    const phone = /^\+?\d{7,20}$/.test(rawPhone) ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

    const me = req.cookies?.ff_member || null; // your current user (if any)

    const out = { ok: true, email: null, phone: null, actions: { needs_merge: false } };

    if (email) {
      const q = await pool.query(
        `SELECT member_id, email_verified_at IS NOT NULL AS verified
           FROM ff_member
          WHERE deleted_at IS NULL AND LOWER(email)=LOWER($1)
          ORDER BY member_id LIMIT 1`,
        [email]
      );
      const row = q.rows[0];
      if (!row) out.email = { status: 'available', member_id: null };
      else if (me && row.member_id === me) out.email = { status: 'owned', member_id: me };
      else if (row.verified) { out.email = { status: 'taken_verified', member_id: row.member_id }; out.actions.needs_merge = true; }
      else out.email = { status: 'taken_unverified', member_id: row.member_id };
    }

    if (phone) {
      const q = await pool.query(
        `SELECT member_id, phone_verified_at IS NOT NULL AS verified
           FROM ff_member
          WHERE deleted_at IS NULL AND phone_e164=$1
          ORDER BY member_id LIMIT 1`,
        [phone]
      );
      const row = q.rows[0];
      if (!row) out.phone = { status: 'available', member_id: null };
      else if (me && row.member_id === me) out.phone = { status: 'owned', member_id: me };
      else if (row.verified) { out.phone = { status: 'taken_verified', member_id: row.member_id }; out.actions.needs_merge = true; }
      else out.phone = { status: 'taken_unverified', member_id: row.member_id };
    }

    res.json(out);
  } catch (e) {
    console.error('[contacts/validate]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});
