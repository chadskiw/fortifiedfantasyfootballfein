// server/routes/espn-auth.js
const express = require('express');
const router = express.Router();

// Fortified Fantasy — ESPN Auth Cookie Setter (Cloudflare Pages Functions)
const ORIGIN = "https://fortifiedfantasy.com";     // your site
const DOMAIN = ".fortifiedfantasy.com";            // apex + subdomains
const MAX_AGE = 300 * 24 * 60 * 60;                // ~300d
const opts = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const set = (res, name, val, maxAge) => res.cookie(name, val, { ...opts, maxAge });
const clear = (res, name) => res.clearCookie(name, { ...opts });

const CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,accept",
  "cache-control": "no-store",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });

// IMPORTANT: do NOT encode cookie values. Set them raw.
function buildCookie(name, value, {
  httpOnly = false,
  secure = true,
  sameSite = "None",
  maxAge = MAX_AGE,
  path = "/",
  domain = DOMAIN,
} = {}) {
  const parts = [
    `${name}=${String(value)}`, // raw
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push("Secure");
  if (httpOnly) parts.push("HttpOnly");
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join("; ");
}

function appendCookies(h, cookies) {
  for (const c of cookies) h.append("Set-Cookie", c);
}

function deleteCookie(name) {
  return buildCookie(name, "", { maxAge: 0, path: "/", domain: DOMAIN, sameSite: "Lax", secure: true });
}

 async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

 async function onRequestGet({ request }) {
  try {
    const url = new URL(request.url);
    let swid = url.searchParams.get("swid");
    const s2  = url.searchParams.get("s2");
    const to  = url.searchParams.get("to");

    if (!swid || !s2) return json({ ok: false, error: "Missing swid or s2" }, 400);

    // Normalize SWID to {GUID} with braces and uppercase
    swid = swid.startsWith("{") ? swid : `{${swid.replace(/^\{|\}$/g, "").toUpperCase()}}`;

    const headers = new Headers(CORS);

    // If you previously encoded cookies, wipe them first so clean ones win
    appendCookies(headers, [
      deleteCookie("SWID"),
      deleteCookie("espn_s2"),
      deleteCookie("fein_has_espn"),
    ]);

    // Set fresh cookies (SWID/espn_s2 HttpOnly; flag readable by JS)
    appendCookies(headers, [
      buildCookie("SWID", swid,            { httpOnly: true }),
      buildCookie("espn_s2", s2,           { httpOnly: true }),
      buildCookie("fein_has_espn", "1",    { httpOnly: false }),
    ]);

    // Build safe redirect target (stay on your domain)
    const self = new URL(request.url);
    let target = `${self.origin}/fein/index.html?season=2025`;
    if (to) {
      try {
        const dest = new URL(to, self.origin);
        if (dest.hostname.endsWith("fortifiedfantasy.com")) target = dest.toString();
      } catch { /* ignore bad to= */ }
    }

    headers.set("location", target);
    // 303 "See Other" for navigation after side effects
    return new Response(null, { status: 303, headers });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// GET: from bookmarklet redirects (?swid=&s2=&to=)
router.get('/', (req, res) => {
  const { swid, s2, to } = req.query;
  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing swid/s2' });

  set(res, 'SWID', swid, 31536000000);     // 365d
  set(res, 'espn_s2', s2, 31536000000);    // 365d
  res.cookie('fein_has_espn', '1', { path:'/', maxAge: 31536000000 }); // non-HttpOnly flag

  // If a return URL provided, go there; else simple JSON
  if (to) return res.redirect(String(to));
  res.json({ ok:true });
});

// POST: from “Paste SWID & S2” fallback
router.post('/', express.json(), (req, res) => {
  const { swid, s2, to } = req.body || {};
  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing swid/s2' });

  set(res, 'SWID', swid, 31536000000);
  set(res, 'espn_s2', s2, 31536000000);
  res.cookie('fein_has_espn', '1', { path:'/', maxAge: 31536000000 });

  res.json({ ok:true, to });
});

// DELETE: logout
router.delete('/', (req, res) => {
  clear(res, 'SWID');
  clear(res, 'espn_s2');
  res.clearCookie('fein_has_espn', { path:'/' });
  res.json({ ok:true, cleared:true });
});

// functions/api/espn-auth.js (example)
 async function onRequestDelete({ request }) {
  return new Response(JSON.stringify({ ok: true, cleared: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": [
        "SWID=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
        "espn_s2=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
        "fein_has_espn=; Max-Age=0; Path=/;"
      ]
    }
  });
}

 async function onRequestPost({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    let { swid, s2 } = body || {};
    if (!swid || !s2) return json({ ok: false, error: "Missing swid or s2" }, 400);

    swid = swid.startsWith("{") ? swid : `{${String(swid).replace(/^\{|\}$/g, "").toUpperCase()}}`;

    const headers = new Headers({ ...CORS, "content-type": "application/json; charset=utf-8" });

    // wipe & set (mirrors GET)
    appendCookies(headers, [
      deleteCookie("SWID"),
      deleteCookie("espn_s2"),
      deleteCookie("fein_has_espn"),
      buildCookie("SWID", swid,         { httpOnly: true }),
      buildCookie("espn_s2", s2,        { httpOnly: true }),
      buildCookie("fein_has_espn", "1", { httpOnly: false }),
    ]);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}
module.exports = router;