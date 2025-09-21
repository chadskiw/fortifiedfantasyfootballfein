// POST /api/identity/contacts/validate
// body: { email?: string, phone?: string }
// returns { ok:true, conflicts:[{field:'email'|'phone', member_id, handle}] }
router.post('/contacts/validate', async (req, res) => {
  try {
    const me = cookieMemberId(req); // current logged-in-ish member (if any)
    const email = (req.body?.email || '').trim().toLowerCase() || null;
    const phone = (req.body?.phone || '').trim() || null;

    const conflicts = [];

    if (email) {
      const hit = await findMemberByEmail(email);
      if (hit && hit.member_id !== me) {
        conflicts.push({ field:'email', member_id: hit.member_id, handle: hit.username || null });
      }
    }
    if (phone) {
      const hit = await findMemberByPhone(phone);
      if (hit && hit.member_id !== me) {
        conflicts.push({ field:'phone', member_id: hit.member_id, handle: hit.username || null });
      }
    }

    if (conflicts.length) {
      return res.status(409).json({
        ok:false,
        error:'contact_conflict',
        message:'One or more contacts already belong to a different account.',
        conflicts
      });
    }
    return res.json({ ok:true, conflicts:[] });
  } catch (e) {
    console.error('[contacts/validate]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
