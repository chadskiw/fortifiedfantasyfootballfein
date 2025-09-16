// functions/api/fein-auth.js
// Alias for /api/espn/link with the same behavior.
// Supports: GET (status), POST (link), DELETE (unlink).
// Accepts body keys: { swid, SWID, s2, espn_s2, to? }  -> sets cookies SWID + espn_s2

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
async function parseBody(req) { return req.json().catch(() => ({})); }

function normSWID(raw) {
  if (!raw) return "";
  try { raw = decodeURIComponent(raw); } catch {}
  raw = raw.trim();
  if (!raw.startsWith("{")) raw = `{${raw.replace(/^\{?|\}?$/g, "")}}`;
  return raw;
}
function setCookie(k, v, { days = 30 } = {}) {
  const maxAge = days * 24 * 60 * 60;
  return `${k}=${encodeURIComponent(v)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookie(k) {
  return `${k}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export const onRequest = async ({ request }) => {
  if (request.method === "GET") {
    const ck = request.headers.get("cookie") || "";
    const hasSWID = /(?:^|;\s*)SWID=/.test(ck);
    const hasS2   = /(?:^|;\s*)espn_s2=/.test(ck);
    return json({ ok: true, linked: hasSWID && hasS2, hasSWID, hasS2 });
  }

  if (request.method === "DELETE") {
    return json({ ok: true, cleared: true }, 200, {
      "set-cookie": [clearCookie("SWID"), clearCookie("espn_s2")],
    });
  }

  if (request.method !== "POST") {
    return json({ ok:false, error: "Use POST to link, GET to check, DELETE to unlink." }, 405);
  }

  const body = await parseBody(request);
  const swid = normSWID(body.SWID || body.swid || "");
  const s2   = String(body.s2 || body.espn_s2 || "").trim();
  if (!swid || !s2) return json({ ok:false, error:"Provide SWID and s2" }, 400);

  return json({ ok:true, linked:true }, 200, {
    "set-cookie": [ setCookie("SWID", swid), setCookie("espn_s2", s2) ],
  });
};
