// /api/espn/link  (Cloudflare Pages Function)
// - GET/POST: set SWID/espn_s2 cookies, fetch ESPN fans, upsert all leagues/teams, redirect
// - DELETE:   clear cookies
// Back-compat: supports ?swid= & ?s2=, POST JSON, or POST form-data.
// Upsert modes (pick what's available):
//   - D1 binding (env.FEIN_D1)  -> uses SQL UPSERT
//   - HTTP target (env.FEIN_META_URL) -> POSTs one JSON per team

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function normSWID(raw) {
  if (!raw) return "";
  try { raw = decodeURIComponent(raw); } catch {}
  raw = raw.trim();
  if (!raw) return "";
  const core = raw.replace(/^\{|\}$/g, "").toUpperCase();
  return `{${core}}`;
}

function makeSetCookie(key, val, { days = 365, httpOnly = true } = {}) {
  const max = Math.max(1, days) * 24 * 60 * 60;
  const flags = [
    `${key}=${encodeURIComponent(val)}`,
    "Path=/",
    `Max-Age=${max}`,
    "Secure",
    "SameSite=Lax",
  ];
  if (httpOnly) flags.push("HttpOnly");
  return flags.join("; ");
}
function clearCookie(key) {
  return `${key}=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly`;
}

function readCookies(cookieHeader = "") {
  const out = {};
  (cookieHeader || "").split(/;\s*/).forEach((p) => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}

async function readBodyCreds(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return {
      SWID: body.SWID || body.swid || body.Swid || "",
      S2: body.espn_s2 || body.s2 || body.ESPN_S2 || "",
      to: body.to || body.return || "",
    };
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await request.formData().catch(() => null);
    return {
      SWID: fd?.get("SWID") || fd?.get("swid") || "",
      S2: fd?.get("espn_s2") || fd?.get("s2") || fd?.get("ESPN_S2") || "",
      to: fd?.get("to") || fd?.get("return") || "",
    };
  }
  return { SWID: "", S2: "", to: "" };
}

async function fetchEspnFans(swid, s2) {
  const url = `https://fantasy.espn.com/apis/v3/games/ffl/fans/${encodeURIComponent(swid)}`;
  const r = await fetch(url, {
    headers: { cookie: `SWID=${swid}; espn_s2=${s2}` },
  });
  if (!r.ok) throw new Error(`ESPN fans fetch failed ${r.status}`);
  return r.json();
}

function carveTeamsFromFansJson(j) {
  const handle = j?.displayName || j?.nickname || null;
  const leagues = Array.isArray(j?.leagues) ? j.leagues : [];
  const rows = [];

  for (const lg of leagues) {
    const season = lg?.seasonId ?? null;
    const leagueId = lg?.id ?? lg?.leagueId ?? null;
    const leagueName = lg?.settings?.name ?? lg?.name ?? null;
    const leagueSize = lg?.settings?.size ?? lg?.members?.length ?? lg?.teams?.length ?? null;

    const teams = Array.isArray(lg?.teams) ? lg.teams : [];
    for (const t of teams) {
      const teamId = t?.id ?? t?.teamId ?? null;
      const teamName =
        (t?.location || "") + (t?.nickname ? ` ${t.nickname}` : "") ||
        t?.name ||
        null;

      if (season && leagueId && teamId) {
        rows.push({
          season,
          platformCode: "018", // ESPN
          leagueId: String(leagueId),
          teamId: String(teamId),
          name: teamName || "",
          handle: handle || "",
          leagueName: leagueName || "",
          leagueSize: Number(leagueSize) || null,
        });
      }
    }
  }
  return rows;
}

// ---------- UPSERT DESTINATIONS ----------

// D1 upsert (if you have a binding named FEIN_D1)
async function upsertToD1(db, rows) {
  if (!rows.length) return;
  const sql = `
    INSERT INTO fein_meta
      (season, platform, league_id, team_id, name, handle, league_name, league_size, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (season, platform, league_id, team_id)
    DO UPDATE SET
      name=excluded.name,
      handle=excluded.handle,
      league_name=excluded.league_name,
      league_size=excluded.league_size,
      updated_at=datetime('now')
  `;
  const stmt = db.prepare(sql);
  const batch = db.batch(
    rows.map(r =>
      stmt.bind(
        r.season,
        "espn",
        r.leagueId,
        r.teamId,
        r.name || "",
        r.handle || "",
        r.leagueName || "",
        r.leagueSize ?? null
      )
    )
  );
  await batch;
}

// HTTP upsert (if you expose a service URL in FEIN_META_URL)
async function upsertViaHttp(url, rows, request) {
  if (!rows.length) return;
  // Fire-and-forget-ish: do them in small parallel chunks
  const headers = {
    "content-type": "application/json",
    // Forward a minimal CSRF/origin context if you need it server-side
    "x-ff-origin": new URL(request.url).origin,
  };
  const chunks = [];
  const copy = rows.slice();
  while (copy.length) chunks.push(copy.splice(0, 8));

  await Promise.all(chunks.map(async (chunk) => {
    await Promise.all(chunk.map(r =>
      fetch(url, { method: "POST", headers, body: JSON.stringify(r) })
        .catch(() => {})
    ));
  }));
}

export const onRequest = async ({ request, env }) => {
  const method = request.method.toUpperCase();

  if (method === "DELETE") {
    return json({ ok: true, cleared: true }, 200, {
      "set-cookie": [
        clearCookie("SWID"),
        clearCookie("espn_s2"),
        // also clear helper:
        `fein_has_espn=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
      ],
    });
  }

  // Gather creds from query/body
  const url = new URL(request.url);
  const qSW = url.searchParams.get("SWID") || url.searchParams.get("swid") || "";
  const qS2 = url.searchParams.get("espn_s2") || url.searchParams.get("s2") || url.searchParams.get("ESPN_S2") || "";
  const qTo = url.searchParams.get("to") || url.searchParams.get("return") || "";

  let { SWID, S2, to } = await readBodyCreds(request);
  SWID = normSWID(SWID || qSW);
  S2   = String(S2 || qS2).trim();
  to   = to || qTo;

  // If no creds provided, just report status
  if (!SWID || !S2) {
    const cookies = readCookies(request.headers.get("cookie") || "");
    const hasSWID = Boolean(cookies.SWID);
    const hasS2   = Boolean(cookies.espn_s2);
    return json({ ok: true, linked: hasSWID && hasS2, hasSWID, hasS2 });
  }

  // Set cookies (plus helper cookie readable by UI)
  const setCookies = [
    makeSetCookie("SWID", SWID, { httpOnly: true }),
    makeSetCookie("espn_s2", S2, { httpOnly: true }),
    // helper flag (NOT HttpOnly) so front-end can detect auth quickly
    makeSetCookie("fein_has_espn", "1", { httpOnly: false }),
  ];

  // Pull ESPN user → leagues/teams
  let rows = [];
  try {
    const fans = await fetchEspnFans(SWID, S2);
    rows = carveTeamsFromFansJson(fans);
  } catch (e) {
    // If ESPN fetch fails, still set cookies and continue
    rows = [];
  }

  // Upsert (choose what you have: D1 or HTTP)
  try {
    if (env.FEIN_D1 && typeof env.FEIN_D1.batch === "function") {
      await upsertToD1(env.FEIN_D1, rows);
    } else if (env.FEIN_META_URL) {
      await upsertViaHttp(env.FEIN_META_URL, rows, request);
    }
  } catch {
    // swallow upsert errors; auth should still proceed
  }

  // Decide redirect target
  let target = to && /^https?:\/\//i.test(to) ? to : null;
  if (!target) {
    // Prefer season from the first row if present; else default 2025
    const season = rows[0]?.season || "2025";
    target = `/fein?season=${encodeURIComponent(String(season))}`;
  }

  // For POST → JSON or Redirect?
  if (method === "POST") {
    // If the POST included a `to`, do a redirect; else return JSON success
    if (to) {
      return new Response(null, {
        status: 302,
        headers: { location: target, "set-cookie": setCookies },
      });
    }
    return json(
      { ok: true, linked: true, teams: rows.length, target },
      200,
      { "set-cookie": setCookies }
    );
  }

  // GET with creds → redirect (or JSON if no 'to')
  if (method === "GET") {
    if (to) {
      return new Response(null, {
        status: 302,
        headers: { location: target, "set-cookie": setCookies },
      });
    }
    return json(
      { ok: true, linked: true, teams: rows.length, target },
      200,
      { "set-cookie": setCookies }
    );
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
};
