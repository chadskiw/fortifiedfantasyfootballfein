// FEIN Auth/Meta Service (Express + Postgres) — CommonJS build for Render
// Routes:
//   GET  /health
//   GET  /fein                          -> route list
//   GET  /fein/upsert-meta              -> browser sanity check
//   POST /fein/upsert-meta              -> UPSERT meta + (optionally) swid/s2  [requires x-fein-key if FEIN_AUTH_KEY set]
//   GET  /fein-auth/by-league?season=&size=[&leagueId=]   -> rows for UI (NO creds)
//   GET  /fein-auth/pool?size=[&season=]                  -> rows for UI (NO creds)
//   GET  /fein-auth/creds?leagueId=&season=               -> { ok, swid, s2 }  [requires x-fein-key if FEIN_AUTH_KEY set]

const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || "").trim();

if (!DB_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Render PG usually needs SSL. Local dev can skip.
const pool = new Pool({
  connectionString: DB_URL,
  max: 3,
  ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
});

const app = express();

// JSON + permissive CORS for CF Pages / localhost
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.set({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-fein-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// helpers
const s = (v) => (v == null ? "" : String(v));
const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const dedup = (arr) =>
  Array.from(new Set((arr || []).flat().map((x) => s(x).trim()).filter(Boolean)));

// auth gate (used for write and creds-read)
function requireKey(req, res, next) {
  if (!WRITE_KEY) return next();
  const k = s(req.headers["x-fein-key"]).trim();
  if (k && k === WRITE_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (bad x-fein-key)" });
}

// routes
app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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
      "GET  /fein-auth/by-league?season=&size=[&leagueId=]",
      "GET  /fein-auth/pool?size=[&season=]",
      "GET  /fein-auth/creds?leagueId=&season=",
    ],
  });
});

// sanity GET
app.get("/fein/upsert-meta", (_req, res) => {
  res.json({
    ok: true,
    hint: "POST JSON here to upsert team meta (and optionally swid/s2)",
    expect: {
      leagueId: "12345",
      teamId: "7",
      season: "2025",
      leagueSize: 12,
      teamName: "Team Name",
      owner: "Owner",
      fbName: "Display Name",
      fbHandle: "@handle",
      fbGroup: ["Group A", "Group B"],
      swid: "{...}", // optional
      s2: "...", // optional
    },
  });
});

// UPSERT meta + optional creds
app.post("/fein/upsert-meta", requireKey, async (req, res) => {
  try {
    const b = req.body || {};
    const leagueId = s(b.leagueId || b.league_id).trim();
    const teamId = s(b.teamId || b.team_id).trim();
    const season = s(b.season || new Date().getFullYear()).trim();
    const leagueSize = n(b.leagueSize ?? b.league_size);

    const name = s(b.teamName ?? b.name).slice(0, 120);
    const handle = s(b.owner ?? b.handle).slice(0, 120);

    const fb_groups = Array.isArray(b.fb_groups)
      ? b.fb_groups
      : dedup([b.fbName, b.fbHandle, b.fbGroup]);

    // OPTIONAL creds — only store if present/non-empty
    const swid = s(b.swid || b.SWID).trim();
    const s2 = s(b.s2 || b.espn_s2).trim();

    if (!leagueId || !teamId || !season) {
      return res
        .status(400)
        .json({ ok: false, error: "leagueId, teamId, season required" });
    }

    const sql = `
      insert into fein_meta (season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      on conflict (season, league_id, team_id)
      do update set
        name        = coalesce(excluded.name, fein_meta.name),
        league_size = coalesce(excluded.league_size, fein_meta.league_size),

        -- overwrite handle only if non-empty is provided
        handle      = coalesce(nullif(excluded.handle, ''), fein_meta.handle),

        -- merge/dedup fb_groups when provided, else keep existing
        fb_groups   = case
                        when excluded.fb_groups is not null and jsonb_array_length(excluded.fb_groups) > 0
                          then (
                            select jsonb_agg(distinct x)
                            from jsonb_array_elements(coalesce(fein_meta.fb_groups, '[]'::jsonb) || excluded.fb_groups) as t(x)
                          )
                        else fein_meta.fb_groups
                      end,

        -- overwrite creds only if non-empty values are provided
        swid        = coalesce(nullif(excluded.swid, ''), fein_meta.swid),
        s2          = coalesce(nullif(excluded.s2,   ''), fein_meta.s2),

        updated_at  = now()
      returning season, league_id, team_id, name, handle, league_size, fb_groups, s2, swid, updated_at
    `;
    const params = [
      season,
      leagueId,
      teamId,
      name || null,
      handle || null,
      leagueSize,
      Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null,
      swid || null,
      s2 || null,
    ];

    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, row: rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------- READ ROUTES for your UI (never expose swid/s2 here) ---------- */

// /fein-auth/by-league?season=2025&size=12[&leagueId=...]
app.get("/fein-auth/by-league", async (req, res) => {
  try {
    const season = s(req.query.season || "").trim();
    const size = n(req.query.size);
    const league = s(req.query.leagueId || req.query.league_id || "").trim();
    if (!season) return res.status(400).json({ ok: false, error: "season required" });
    if (!size) return res.status(400).json({ ok: false, error: "size required" });

    const params = [season, size];
    let sql = `
      select season, league_id, team_id, name as team_name, handle,
             league_size, fb_groups, updated_at
      from fein_meta
      where season = $1 and league_size = $2
    `;
    if (league) {
      sql += ` and league_id = $3`;
      params.push(league);
    }
    sql += ` order by league_id, team_id`;

    const { rows } = await pool.query(sql, params);
    const shaped = rows.map((r) => ({
      league_id: r.league_id,
      season: r.season,
      league_size: r.league_size,
      team_id: r.team_id,
      name: r.team_name,
      handle: r.handle,
      fb_groups: r.fb_groups,
    }));
    res.json({ ok: true, rows: shaped });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// /fein-auth/pool?size=12[&season=2025]
app.get("/fein-auth/pool", async (req, res) => {
  try {
    const size = n(req.query.size);
    if (!size) return res.status(400).json({ ok: false, error: "size required" });
    const season = s(req.query.season || "").trim();

    const params = [size];
    let sql = `
      select season, league_id, team_id, name as team_name, handle,
             league_size, fb_groups, updated_at
      from fein_meta
      where league_size = $1
    `;
    if (season) {
      sql += ` and season = $2`;
      params.push(season);
    }
    sql += ` order by season desc, league_id, team_id`;

    const { rows } = await pool.query(sql, params);
    const shaped = rows.map((r) => ({
      league_id: r.league_id,
      season: r.season,
      league_size: r.league_size,
      team_id: r.team_id,
      name: r.team_name,
      handle: r.handle,
      fb_groups: r.fb_groups,
    }));
    res.json({ ok: true, rows: shaped });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------- SECURED CREDS READBACK for CF Pages fallback ---------- */
// /fein-auth/creds?leagueId=&season=
// Requires x-fein-key if FEIN_AUTH_KEY is set.
app.get("/fein-auth/creds", requireKey, async (req, res) => {
  try {
    const leagueId = s(req.query.leagueId || req.query.league_id).trim();
    const season = s(req.query.season || req.query.year || "").trim();
    if (!leagueId) return res.status(400).json({ ok: false, error: "leagueId required" });

    let row;
    if (season) {
      const q = await pool.query(
        `select swid, s2 from fein_meta
         where league_id = $1 and season = $2 and swid is not null and s2 is not null
         order by updated_at desc limit 1`,
        [leagueId, season]
      );
      row = q.rows?.[0];
    } else {
      const q = await pool.query(
        `select swid, s2 from fein_meta
         where league_id = $1 and swid is not null and s2 is not null
         order by updated_at desc limit 1`,
        [leagueId]
      );
      row = q.rows?.[0];
    }

    if (!row?.swid || !row?.s2) {
      return res.status(404).json({ ok: false, error: "no stored creds" });
    }
    res.json({ ok: true, swid: row.swid, s2: row.s2 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// bootstrap schema then start server
async function ensureSchema() {
  await pool.query(`
    create table if not exists fein_meta (
      season      text not null,
      league_id   text not null,
      team_id     text not null,
      name        text,
      handle      text,
      league_size int,
      fb_groups   jsonb,
      swid        text,
      s2          text,
      updated_at  timestamptz not null default now(),
      primary key (season, league_id, team_id)
    );
  `);
  await pool.query(`alter table fein_meta add column if not exists fb_groups jsonb;`);
  await pool.query(`alter table fein_meta add column if not exists swid text;`);
  await pool.query(`alter table fein_meta add column if not exists s2   text;`);
  await pool.query(`create index if not exists fein_meta_season_size_idx on fein_meta(season, league_size);`);
  await pool.query(`create index if not exists fein_meta_league_idx on fein_meta(league_id);`);
  await pool.query(`
    create index if not exists fein_meta_creds_idx
      on fein_meta(league_id, season, updated_at)
      where swid is not null and s2 is not null;
  `);
  console.log("[db] schema ready");
}

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`fein-auth-service listening on :${PORT}`));
  })
  .catch((e) => {
    console.error("[db] init failed:", e);
    process.exit(1);
  });
