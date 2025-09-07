// Express microservice for FEIN auth/meta storage
// Routes:
//   GET  /health
//   POST /fein/upsert-meta   (secured with x-fein-key if provided)
//
// Env:
//   PORT                -> default 3000
//   DATABASE_URL        -> Postgres connection string
//   FEIN_AUTH_KEY       -> optional shared secret for writes
//
// Table (DDL below): fein_meta (season, league_id, team_id) PK; plus name, handle, league_size, fb_groups

import express from "express";
import { Pool } from "pg";

const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || "").trim();

if (!DB_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, max: 3 });
const app = express();
app.use(express.json({ limit: "256kb" }));

// small helpers
const str = (v) => (v == null ? "" : String(v));
const intOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dedup = (arr) => Array.from(new Set((arr || []).flat().map((x) => str(x).trim()).filter(Boolean)));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1 as ok");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// (optional) simple GET to confirm route exists
app.get("/fein/upsert-meta", (_req, res) => {
  res.json({
    ok: true,
    hint: "POST JSON here to upsert",
    expect: {
      leagueId: "12345",
      teamId: "7",
      season: "2025",
      leagueSize: 12,
      name: "Team Name",
      handle: "Owner",
      fb_groups: ["Name", "@handle", "Group A"]
    }
  });
});

// Require x-fein-key if FEIN_AUTH_KEY is set
function requireKey(req, res, next) {
  if (!WRITE_KEY) return next();
  const k = (req.headers["x-fein-key"] || "").toString().trim();
  if (k && k === WRITE_KEY) return next();
  res.status(401).json({ ok: false, error: "Unauthorized (bad x-fein-key)" });
}

app.post("/fein/upsert-meta", requireKey, async (req, res) => {
  try {
    // Accept both your worker’s payload and older variants
    const body = req.body || {};
    const leagueId   = str(body.leagueId || body.league_id).trim();
    const teamId     = str(body.teamId   || body.team_id).trim();
    const season     = str(body.season || new Date().getFullYear()).trim();
    const leagueSize = intOrNull(body.leagueSize ?? body.league_size);

    const name   = str(body.teamName ?? body.name).slice(0, 120);
    const handle = str(body.owner ?? body.handle).slice(0, 120);

    // fb groups / metadata
    const fb_groups = Array.isArray(body.fb_groups)
      ? body.fb_groups
      : dedup([body.fbName, body.fbHandle, body.fbGroup]);

    if (!leagueId || !teamId || !season) {
      return res.status(400).json({ ok: false, error: "leagueId, teamId, season required" });
    }

    // Upsert
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
      season,
      leagueId,
      teamId,
      name || null,
      handle || null,
      leagueSize,
      Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null
    ];
    const { rows } = await pool.query(sql, params);

    res.json({ ok: true, row: rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`fein-auth-service listening on :${PORT}`);
});
