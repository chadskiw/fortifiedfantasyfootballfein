function requireEspnCreds(req, res, next) {
  if (extractEspnCreds(req)) return next();
  return res.status(401).json({ ok:false, error:'no_espn_creds' });
}