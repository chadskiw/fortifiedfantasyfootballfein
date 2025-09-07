// Minimal, safe baseline for your Render Web Service.
//
// Routes we expose (all CORS-enabled):
//   GET  /health                       -> { ok:true }
//   GET  /fein                         -> route list
//   GET  /fein/upsert-meta             -> hint JSON (sanity check in browser)
//   POST /fein/upsert-meta             -> accepts team meta; echoes back (DB optional)
//   GET  /fein-auth/creds              -> stub creds endpoint (returns 404 {ok:false})
//   POST /fein-auth                    -> compatibility alias; maps body & echoes
//
// Env (optional):
//   PORT             - Render sets it
//   DATABASE_URL     - Postgres URL (optional)
//   FEIN_AUTH_KEY    - if set, POST routes require header x-fein-key with this value

const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || "").trim();
const DB_URL = process.env.DATABASE_URL || "";

const app = express();

// --- middleware: JSON + CORS ---
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.set({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-fein-key"
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// --- optional DB (only if DATABASE_URL is set) ---
let pool = null;
if (DB_URL) {
  pool = new Pool({ connectionString: DB_URL, max: 3 });
  // create table if missing (non-fatal)
  (async () => {
    try {
      await pool.query(`
        create table if not exists fein_meta (
          season      text not null,
          league_id   text not null,
          team_id     text not null,
          name        text,
          handle      text,
          league_size int,
          fb_groups   jsonb,
          updated_at  timestamptz not null default now(),
          primary key (season, league_id, team_id)
        );
      `);
      console.log("[db] ready");
    } catch (e) {
      console.warn("[db] init skipped:", e.message);
      pool = null; // run without DB
    }
  })();
}

// --- helpers ---
const s = v => (v == null ? "" : String(v));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dedup = arr => Array.from(new Set((arr || []).flat().map(x => s(x).trim()).filter(Boolean)));

function requireKey(req, res, next) {
  if (!WRITE_KEY) return next();
  const k = s(req.headers["x-fein-key"]).trim();
  if (k && k === WRITE_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (bad x-fein-key)" });
}

// --- routes ---
app.get("/health", async (_req, res) => {
  try {
    if (pool) await pool.query("select 1");
    res.json({ ok: true, db: !!pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/fein", (_req, res) => {
  res.json({
    ok: true,
    routes: [
      "GET  /health",
      "GET  /fein",
      "GET  /fein/upsert-meta",
      "POST /fein/upsert-meta",
      "GET  /fein-auth/creds (stub)",
      "POST /fein-auth (alias to upsert)"
    ]
  });
});

// sanity-check GET so you can open it in a browser
app.get("/fein/upsert-meta", (_req, res) => {
  res.json({
    ok: true,
    hint: "POST JSON here to upsert team meta",
    expect: {
      leagueId: "12345",
      teamId: "7",
      season: "2025",
      leagueSize: 12,
      teamName: "Team Name",
      owner: "Owner",
      fbName: "Display Name",
      fbHandle: "@handle",
      fbGroup: ["Group A", "Group B"]
    }
  });
});

// main POST route your CF worker hits
app.post("/fein/upsert-meta", requireKey, async (req, res) => {
  try {
    const body = req.body || {};
    const leagueId   = s(body.leagueId || body.league_id).trim();
    const teamId     = s(body.teamId   || body.team_id).trim();
    const season     = s(body.season || new Date().getFullYear()).trim();
    const leagueSize = n(body.leagueSize ?? body.league_size);
    const name       = s(body.teamName ?? body.name).slice(0, 120);
    const handle     = s(body.owner ?? body.handle).slice(0, 120);

    const fb_groups = Array.isArray(body.fb_groups)
      ? body.fb_groups
      : dedup([body.fbName, body.fbHandle, body.fbGroup]);

    if (!leagueId || !teamId || !season) {
      return res.status(400).json({ ok: false, error: "leagueId, teamId, season required" });
    }

    // If DB configured, upsert; else just echo back success so UI flow continues
    if (pool) {
      const sql = `
        insert into fein_meta (season, league_id, team_id, name, handle, league_size, fb_groups, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7, now())
        on conflict (season, league_id, team_id)
        do update set
          name        = coalesce(excluded.name, fein_meta.name),
          handle      = coalesce(excluded.handle, fein_meta.handle),
          league_size = coalesce(excluded.league_size, fein_meta.league_size),
          fb_groups   = case
                          when excluded.fb_groups is not null and jsonb_array_length(excluded.fb_groups) > 0
                            then (
                              select jsonb_agg(distinct x)
                              from jsonb_array_elements(coalesce(fein_meta.fb_groups, '[]'::jsonb) || excluded.fb_groups) as t(x)
                            )
                          else fein_meta.fb_groups
                        end,
          updated_at  = now()
        returning season, league_id, team_id, name, handle, league_size, fb_groups, updated_at
      `;
      const params = [
        season, leagueId, teamId,
        name || null, handle || null, leagueSize,
        Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null
      ];
      const { rows } = await pool.query(sql, params);
      return res.json({ ok: true, stored: true, row: rows[0] || null });
    }

    // no DB — still succeed
    res.json({
      ok: true, stored: false,
      row: { season, leagueId, teamId, name, handle, leagueSize, fb_groups: dedup(fb_groups) }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// old compatibility paths (your worker used to hit these)
app.get("/fein-auth/creds", (_req, res) => {
  // Return 404 but JSON shape; your CF code treats non-200 as "no creds"
  res.status(404).json({ ok: false, error: "no stored creds" });
});
app.post("/fein-auth", requireKey, (req, res) => {
  // Map to new shape and reuse handler response format
  const b = req.body || {};
  res.json({
    ok: true,
    stored: false,
    row: {
      season: s(b.season || new Date().getFullYear()),
      leagueId: s(b.leagueId || b.league_id),
      teamId: s(b.teamId || b.team_id),
      name: s(b.name),
      handle: s(b.handle),
      leagueSize: n(b.league_size),
      fb_groups: Array.isArray(b.fb_groups) ? b.fb_groups : dedup([b.fbName, b.fbHandle, b.fbGroup])
    }
  });
});

app.listen(PORT, () => {
  console.log(`fein-auth-service listening on :${PORT} (db=${!!pool})`);
});
