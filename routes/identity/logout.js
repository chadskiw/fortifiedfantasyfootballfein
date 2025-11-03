// routes/identity/logout.js
router.post('/logout', (req, res) => {
  // Clear Site Data (cookies+storage). Works in Chromium/Firefox; Safari partial.
  res.set('Clear-Site-Data', '"cookies", "storage"');

  const base = {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    domain: '.fortifiedfantasy.com', // adjust if needed
  };

  // Clear all auth/session cookies here:
  res.clearCookie('ff_member', base);
  res.clearCookie('ff_logged_in', base);
  res.clearCookie('s2', base);      // if you set ESPN proxy cookies
  res.clearCookie('swid', base);
  // …any others you set as HttpOnly…

  // kill server session if you have one
  try { req.session?.destroy?.(()=>{}); } catch {}

  return res.status(204).end();
});
