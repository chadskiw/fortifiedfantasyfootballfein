// routes/identity/promote.js
const express = require('express');
const { promoteQuickhitterToMember } = require('../../src/db/promoteQuickhitter');

const router = express.Router();
router.use(express.json());

// POST /api/identity/promote
// body: { member_id? (defaults cookie), adj1, adj2, noun }
router.post('/promote', async (req, res) => {
  try {
    const member_id = (req.body?.member_id || req.cookies?.ff_member || '').trim();
    const adj1 = (req.body?.adj1 || '').trim();
    const adj2 = (req.body?.adj2 || '').trim();
    const noun = (req.body?.noun || '').trim();

    if (!member_id) return res.status(400).json({ ok:false, error:'missing_member' });
    if (!adj1 || !adj2 || !noun) return res.status(400).json({ ok:false, error:'need_adj_adj_noun' });
    if (adj1.toLowerCase() === adj2.toLowerCase()) return res.status(400).json({ ok:false, error:'adjs_must_differ' });

    const out = await promoteQuickhitterToMember({ member_id, adj1, adj2, noun });
    if (!out.ok) return res.status(400).json(out);

    res.json({ ok:true, member_id: out.member_id });
  } catch (e) {
    console.error('[identity.promote]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
