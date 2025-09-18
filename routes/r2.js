// r2.js — Fortified Fantasy request + identity helper
// - Ensures a long-lived 'ff-interacted' cookie (8-char A-Z0-9)
// - Auto-attaches ID to all outgoing requests via 'X-FF-ID' header
// - Optional: also append as ?ffid= to URLs
// - Exposes helpers: FFID.getId(), FFID.ensure(), FFID.rotate(), FFID.withId(url), FFID.attachVerify(...)

const FFID = (() => {
  const COOKIE_NAME = 'ff-interacted';
  const HEADER_NAME = 'X-FF-ID';

  // ---------- utils ----------
  function nowPlusYears(n = 2) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + n);
    return d;
  }
  function topLevelDomain(optDomain) {
    if (optDomain) return optDomain;
    try {
      // Best-effort: use current host; if it has 2+ dots, drop the first label.
      const host = location.hostname;
      const parts = host.split('.').filter(Boolean);
      if (parts.length >= 3) return '.' + parts.slice(-2).join('.');
      return host; // e.g. localhost or example.com
    } catch {
      return location.hostname;
    }
  }
  function setCookie(name, value, { years = 2, domain, path = '/', sameSite = 'Lax' } = {}) {
    const e = nowPlusYears(years).toUTCString();
    const protoSecure = location.protocol === 'https:';
    const dom = domain ? `; domain=${domain}` : '';
    const secure = protoSecure ? '; Secure' : '';
    document.cookie = `${name}=${value}; expires=${e}; path=${path}; SameSite=${sameSite}${dom}${secure}`;
  }
  function getCookie(name) {
    return (document.cookie || '')
      .split('; ')
      .find((row) => row.startsWith(name + '='))
      ?.split('=')[1] || '';
  }
  function delCookie(name, { domain, path = '/' } = {}) {
    const dom = domain ? `; domain=${domain}` : '';
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${dom}`;
  }

  function secureRandomId(len = 8) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const out = [];
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) out.push(CHARS[arr[i] % CHARS.length]);
    return out.join('');
  }

  // LocalStorage mirror to survive some ITP quirks
  function readMirror() {
    try { return localStorage.getItem(COOKIE_NAME) || ''; } catch { return ''; }
  }
  function writeMirror(v) {
    try { localStorage.setItem(COOKIE_NAME, v); } catch {}
  }

  function ensure({ domain } = {}) {
    let v = getCookie(COOKIE_NAME);
    if (!v) v = readMirror();
    if (!v) v = secureRandomId(8);

    setCookie(COOKIE_NAME, v, { years: 2, domain });
    writeMirror(v);
    return v;
  }

  function rotate({ domain } = {}) {
    const v = secureRandomId(8);
    setCookie(COOKIE_NAME, v, { years: 2, domain });
    writeMirror(v);
    return v;
  }

  function getId() {
    return getCookie(COOKIE_NAME) || readMirror() || '';
  }

  function withId(url, param = 'ffid') {
    const id = getId();
    if (!id) return url;
    try {
      const u = new URL(url, location.href);
      u.searchParams.set(param, id);
      return u.toString();
    } catch {
      // Fallback for relative/non-standard
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}${encodeURIComponent(param)}=${encodeURIComponent(id)}`;
    }
  }

  // ---------- request interceptors ----------
  let fetchPatched = false;
  let xhrPatched = false;

  function patchFetch({ headerName = HEADER_NAME, alsoQuery = false, queryParam = 'ffid' } = {}) {
    if (fetchPatched || !window.fetch) return;
    const _fetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const id = getId() || ensure();
      // Clone headers
      const headers = new Headers(init.headers || {});
      if (id && headerName) headers.set(headerName, id);

      // Optional query param
      let req = input;
      if (alsoQuery && typeof input === 'string') {
        req = withId(input, queryParam);
      } else if (alsoQuery && input && input.url) {
        req = new Request(withId(input.url, queryParam), input);
      }

      return _fetch(req, { ...init, headers });
    };
    fetchPatched = true;
  }

  function patchXHR({ headerName = HEADER_NAME, alsoQuery = false, queryParam = 'ffid' } = {}) {
    if (xhrPatched || !window.XMLHttpRequest) return;
    const X = window.XMLHttpRequest;

    const open = X.prototype.open;
    const send = X.prototype.send;

    X.prototype.__ff_cfg = { method: 'GET', url: '' };

    X.prototype.open = function(method, url, async, user, password) {
      this.__ff_cfg = { method, url };
      if (alsoQuery && url) {
        const munged = withId(url, queryParam);
        return open.call(this, method, munged, async, user, password);
      }
      return open.call(this, method, url, async, user, password);
    };

    X.prototype.send = function(body) {
      try {
        const id = getId() || ensure();
        if (id) this.setRequestHeader(headerName, id);
      } catch {}
      return send.call(this, body);
    };

    xhrPatched = true;
  }

  // ---------- interaction detection ----------
  // First meaningful interaction: file upload, username/email/phone input, or explicit event.
  function primeOnInteraction({ domain } = {}) {
    const fire = () => ensure({ domain });

    // Any input on username/phone/email fields
    const selector = [
      'input[type="email"]',
      'input[type="tel"]',
      'input[name*="email" i]',
      'input[name*="phone" i]',
      'input[name*="username" i]',
      'input[type="file"]',
      '[data-ff-interaction]'
    ].join(',');

    const once = (el, ev) => el.addEventListener(ev, fire, { once: true, passive: true });

    // Attach listeners to existing nodes
    document.querySelectorAll(selector).forEach((el) => {
      once(el, 'change');
      once(el, 'input');
    });

    // Catch-all: first click or key press anywhere
    window.addEventListener('click', fire, { once: true, passive: true });
    window.addEventListener('keydown', fire, { once: true });

    // Custom event for programmatic flows
    window.addEventListener('ff:interacted', fire, { once: true });
  }

  // ---------- verify helper ----------
  // Wire a button to POST to an endpoint; server matches cookie/header
  async function verify(endpoint = '/api/verify', body = {}, fetchInit = {}) {
    const id = getId() || ensure();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_NAME]: id
      },
      body: JSON.stringify({ ffid: id, ...body }),
      ...fetchInit
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Verify failed (${res.status}): ${text || 'No details'}`);
    }
    return res.json().catch(() => ({}));
  }

  function attachVerify(button, { endpoint = '/api/verify', payload = {}, onSuccess, onError } = {}) {
    if (!button) return;
    button.addEventListener('click', async () => {
      try {
        const data = await verify(endpoint, payload);
        onSuccess?.(data);
      } catch (err) {
        onError?.(err);
      }
    });
  }

  // ---------- init ----------
  function init(options = {}) {
    const {
      domain = undefined,          // e.g. '.fortifiedfantasy.com'
      autoEnsure = true,           // create the cookie on first interaction (or immediately if eagerEnsure)
      eagerEnsure = false,         // set immediately on init instead of waiting for interaction
      attach = true,               // patch fetch/XMLHttpRequest
      headerName = HEADER_NAME,
      alsoQuery = false,
      queryParam = 'ffid'
    } = options;

    if (attach) {
      patchFetch({ headerName, alsoQuery, queryParam });
      patchXHR({ headerName, alsoQuery, queryParam });
    }

    if (eagerEnsure) {
      ensure({ domain });
    } else if (autoEnsure) {
      primeOnInteraction({ domain });
    }
  }

  return {
    // lifecycle
    init,
    // id management
    ensure,
    rotate,
    getId,
    withId,
    // verification
    verify,
    attachVerify,
    // cookie utils (exported just in case)
    _util: { setCookie, getCookie, delCookie }
  };
})();

// Auto-init with sensible defaults (header only; create on first interaction)
FFID.init();

// Expose globally
window.FFID = FFID;

// Optional: module export
export default FFID;
