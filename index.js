const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ---- Env ----
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || ""; // optional
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG requires SSL
});

// ---- helpers ----
function ok(res, data = {}) { return res.json({ ok: true, ...data }); }
function bad(res, code, msg) { return res.status(code).json({ ok: false, error: msg }); }
function needAuth(req, res) {
  if (!AUTH_SECRET) return false;
  if (req.get('x-fein-key') === AUTH_SECRET) return false;
  bad(res, 401, 'unauthorized'); 
  return true;
}

// ---- basic routes ----
app.get('/', (_req, res) => res.type('text/plain').send('FEIN auth service is running'));
app.get('/healthz', async (_req, res) => {
  try { await pool.query('select 1'); res.type('text/plain').send('ok'); }
  catch (e) { res.status(500).type('text/plain').send('db error: ' + e.message); }
});

// ---- table bootstrap helper (optional: call once manually) ----
app.post('/__init', async (req, res) => {
  if (needAuth(req, res)) return;
  try {
    const sql = `
      create table if not exists public.fein_teams (
        league_id   bigint not null,
        team_id     bigint not null,
        season      int    not null,
        name        text,
        handle      text,
        league_size int,
        fb_groups   jsonb,        -- store ["fbName","fbGroup","fbHandle"] or null
        swid        text,
        espn_s2     text,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        primary key (league_id, team_id, season)
      );
      create or replace function public.set_updated_at() returns trigger as $$
      begin new.updated_at = now(); return new; end; $$ language plpgsql;
      drop trigger if exists tg_fein_teams_updated on public.fein_teams;
      create trigger tg_fein_teams_updated
        before update on public.fein_teams
        for each row execute procedure public.set_updated_at();
    `;
    await pool.query(sql);
    ok(res, { created: true });
  } catch (e) {
    bad(res, 500, String(e));
  }
});

// ---- GET /fein-auth?leagueId&teamId&season  (read stored creds/meta) ----
app.get('/fein-auth', async (req, res) => {
  try {
    const { leagueId, teamId, season } = req.query;
    if (!leagueId || !teamId || !season) {
      return bad(res, 400, 'leagueId, teamId, season required');
    }
    const q = `
      select league_id, team_id, season, name, handle, league_size, fb_groups, swid, espn_s2
      from public.fein_teams
      where league_id = $1 and team_id = $2 and season = $3
      limit 1
    `;
    const { rows } = await pool.query(q, [leagueId, teamId, season]);
    if (!rows.length) return bad(res, 404, 'not found');
    ok(res, rows[0]);
  } catch (e) {
    bad(res, 500, String(e));
  }
});

// ---- POST /fein-auth  (upsert; tokens optional) ----
// Body: { leagueId, teamId, season, swid?, espn_s2?, name?, handle?, league_size?, fb_groups? }
app.post('/fein-auth', async (req, res) => {
  try {
    if (needAuth(req, res)) return;

    const {
      leagueId, teamId, season,
      swid = null, espn_s2 = null,
      name = null, handle = null, league_size = null, fb_groups = null
    } = req.body || {};

    if (!leagueId || !teamId || !season) {
      return bad(res, 400, 'leagueId, teamId, season required');
    }

    const q = `
      insert into public.fein_teams
        (league_id, team_id, season, swid, espn_s2, name, handle, league_size, fb_groups)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (league_id, team_id, season)
      do update set
        swid        = coalesce(excluded.swid,        public.fein_teams.swid),
        espn_s2     = coalesce(excluded.espn_s2,     public.fein_teams.espn_s2),
        name        = coalesce(excluded.name,        public.fein_teams.name),
        handle      = coalesce(excluded.handle,      public.fein_teams.handle),
        league_size = coalesce(excluded.league_size, public.fein_teams.league_size),
        fb_groups   = coalesce(excluded.fb_groups,   public.fein_teams.fb_groups),
        updated_at  = now()
      returning league_id, team_id, season, name, handle, league_size, fb_groups, swid, espn_s2
    `;
    const params = [
      leagueId, teamId, season, swid, espn_s2, name, handle, league_size,
      (fb_groups == null ? null : JSON.stringify(fb_groups))
    ];
    const { rows } = await pool.query(q, params);
    ok(res, rows[0]);
  } catch (e) {
    bad(res, 500, String(e));
  }
});

app.listen(PORT, () => {
  console.log(`FEIN auth service listening on ${PORT}`);
});
