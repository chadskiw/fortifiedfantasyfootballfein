const cookie = require('cookie');
const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function makeCode(n=8){ let s=''; for(let i=0;i<n;i++) s+=ALPH[(Math.random()*ALPH.length)|0]; return s; }

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parsed = cookie.parse(raw);
  return parsed[name];
}
function setCookie(res, name, val, opts={}) {
  const str = cookie.serialize(name, val, {
    path: '/', maxAge: 60*60*24*365*10, sameSite: 'lax', secure: true, ...opts,
  });
  res.append('Set-Cookie', str);
}
function ensureInteracted(req, res) {
  let code = readCookie(req, 'ff-interacted');
  let isNew = false;
  if (!/^[A-Z0-9]{8}$/.test(code || '')) {
    code = makeCode(8);
    isNew = true;
    setCookie(res, 'ff-interacted', code);
  }
  return { code, isNew };
}

module.exports = { makeCode, ensureInteracted };
