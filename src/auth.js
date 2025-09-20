// TRUE_LOCATION: src/auth.js
// IN_USE: FALSE
function readAuthFromRequest(req){
  const h = req.headers || {};
  let swid = h['x-espn-swid'] || '';
  let s2   = h['x-espn-s2']   || '';

  const cookie = h.cookie || '';
  if (!swid) swid = decodeURIComponent((cookie.match(/SWID=([^;]+)/i)?.[1] || ''));
  if (!s2)   s2   = decodeURIComponent((cookie.match(/(?:^|;\s*)espn_s2=([^;]+)/i)?.[1] || ''));

  const u = new URL(req.protocol + '://' + (req.headers.host || '') + req.originalUrl);
  if (!swid) swid = u.searchParams.get('swid') || '';
  if (!s2)   s2   = u.searchParams.get('espn_s2') || '';

  if (swid && !/^\{.*\}$/.test(swid)) swid = '{' + swid.replace(/^\{|\}$/g, '') + '}';
  return { swid, s2 };
}

module.exports = { readAuthFromRequest };
