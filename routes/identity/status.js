// GET /api/identity/status
// Looks at cookies (ff_member, SWID/espn_s2) and returns display info
router.get('/status', async (req, res) => {
  try {
    const mid = cookieMemberId(req);
    let member = null;
    if (mid) {
      const r = await pool.query(
        `SELECT member_id, username, color_hex, image_key, image_etag, image_format, image_version
           FROM ff_member
          WHERE deleted_at IS NULL AND member_id = $1
          LIMIT 1`,
        [mid]
      );
      member = r.rows[0] || null;
    }

    const cookies = req.cookies || {};
    const hasEspn = Boolean(cookies.SWID || cookies.ESPN_S2 || cookies.espn_s2);
    const avatarUrl = (member && member.image_key)
      ? `/media/${member.image_key}?v=${member.image_version || 0}`
      : null;

    // suggest UI actions
    const suggestions = [];
    if (member) suggestions.push('cookie');        // “Are you … ?”
    suggestions.push('passcode');                  // fallback
    if (hasEspn) suggestions.push('espn');         // if you want to show ESPN-based login

    res.json({
      ok:true,
      member: member ? {
        member_id: member.member_id,
        handle: member.username || null,
        color_hex: member.color_hex || null,
        avatar_url: avatarUrl
      } : null,
      cookies: { hasEspn },
      suggestions
    });
  } catch (e) {
    console.error('[identity/status]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});
