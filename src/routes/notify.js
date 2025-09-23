// routes/notify.js
const express = require('express');
const router = express.Router();
const { sendTeamsUpdateEmail } = require('../notify');

// POST /api/_notify/teams-update  { url?, subject? }
router.post('/teams-update', express.json(), async (req, res) => {
  try {
    const subject = req.body?.subject || 'Teams Update';
    const url     = String(req.body?.url || '').trim();
    const ok = await sendTeamsUpdateEmail({
      subject,
      html: `<p>${url ? 'URL:' : ''} ${url}</p>`
    });
    return res.json({ ok });
  } catch (e) {
    console.error('[notify/teams-update]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
