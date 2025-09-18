/* public/fein/r2.js */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null); // CJS-safe: export no-op in Node
  } else {
    root.FFID = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  if (!root || typeof window === 'undefined' || typeof document === 'undefined') {
    const noop = () => {}; const idless = () => '';
    return { init: noop, ensure: idless, rotate: idless, getId: idless, withId: (u)=>u,
      verify: async ()=>({}), attachVerify: noop, _util: { setCookie: noop, getCookie: idless, delCookie: noop } };
  }

  const COOKIE_NAME = 'ff-interacted';
  const HEADER_NAME = 'X-FF-ID';

  function setCookie(name, value, { years = 2, domain, path = '/', sameSite = 'Lax' } = {}) {
    const d = new Date(); d.setFullYear(d.getFullYear() + years);
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const dom = domain ? `; domain=${domain}` : '';
    document.cookie = `${name}=${value}; expires=${d.toUTCString()}; path=${path}; SameSite=${sameSite}${dom}${secure}`;
  }
  const getCookie = (name) =>
    (document.cookie || '').split('; ').find(r => r.startsWith(name + '='))?.split('=')[1] || '';
  function secureRandomId(len = 8) {
    const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const arr = new Uint32Array(len); crypto.getRandomValues(arr);
    let out = ''; for (let i=0;i<len;i++) out += CH[arr[i] % CH.length]; return out;
  }
  function ensure({ domain } = {}) {
    let v = getCookie(COOKIE_NAME);
    if (!v) v = secureRandomId(8);
    setCookie(COOKIE_NAME, v, { years: 2, domain });
    try { localStorage.setItem(COOKIE_NAME, v); } catch {}
    return v;
  }
  const getId = () => getCookie(COOKIE_NAME) || localStorage.getItem(COOKIE_NAME) || '';
  function withId(url, param = 'ffid') {
    const id = getId() || ensure(); if (!id) return url;
    try { const u = new URL(url, location.href); u.searchParams.set(param, id); return u.toString(); }
    catch { const sep = url.includes('?') ? '&' : '?'; return `${url}${sep}${param}=${id}`; }
  }

  let fetchPatched = false, xhrPatched = false;
  function patchFetch({ headerName = HEADER_NAME, alsoQuery = false, queryParam = 'ffid' } = {}) {
    if (fetchPatched || !window.fetch) return;
    const _fetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const id = getId() || ensure();
      const headers = new Headers(init.headers || {}); if (id) headers.set(headerName, id);
      let req = input;
      if (alsoQuery) {
        if (typeof input === 'string') req = withId(input, queryParam);
        else if (input && input.url) req = new Request(withId(input.url, queryParam), input);
      }
      return _fetch(req, { ...init, headers });
    };
    fetchPatched = true;
  }
  function patchXHR({ headerName = HEADER_NAME, alsoQuery = false, queryParam = 'ffid' } = {}) {
    if (xhrPatched || !window.XMLHttpRequest) return;
    const X = window.XMLHttpRequest, open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function (method, url, async, user, password) {
      const u = (alsoQuery && url) ? withId(url, queryParam) : url;
      return open.call(this, method, u, async, user, password);
    };
    X.prototype.send = function (body) {
      try { const id = getId() || ensure(); if (id) this.setRequestHeader(HEADER_NAME, id); } catch {}
      return send.call(this, body);
    };
    xhrPatched = true;
  }

  function primeOnInteraction({ domain } = {}) {
    const fire = () => ensure({ domain });
    const selector = [
      'input[type="email"]','input[type="tel"]','input[name*="email" i]',
      'input[name*="phone" i]','input[name*="username" i]','input[type="file"]','[data-ff-interaction]'
    ].join(',');
    const once = (el, ev) => el.addEventListener(ev, fire, { once: true, passive: true });
    document.querySelectorAll(selector).forEach((el) => { once(el,'change'); once(el,'input'); });
    window.addEventListener('click', fire, { once: true, passive: true });
    window.addEventListener('keydown', fire, { once: true });
    window.addEventListener('ff:interacted', fire, { once: true });
  }

  async function verify(endpoint = '/api/identity/verify', body = {}, init = {}) {
    const id = getId() || ensure();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [HEADER_NAME]: id },
      body: JSON.stringify({ ffid: id, ...body }),
      ...init
    });
    if (!res.ok) throw new Error(`Verify failed (${res.status})`);
    try { return await res.json(); } catch { return {}; }
  }
  function attachVerify(btn, opts = {}) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try { const data = await verify(opts.endpoint, opts.payload, opts.fetchInit); opts.onSuccess?.(data); }
      catch (e) { opts.onError?.(e); }
    });
  }

  function init(options = {}) {
    const { domain, autoEnsure = true, eagerEnsure = false, attach = true, alsoQuery = false } = options;
    if (attach) { patchFetch({ alsoQuery }); patchXHR({ alsoQuery }); }
    if (eagerEnsure) ensure({ domain }); else if (autoEnsure) primeOnInteraction({ domain });
  }

  init();
  return { init, ensure, getId, withId, verify, attachVerify };
});
