import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pkg from 'pg';

const { Pool } = pkg;

// NOTE: DATABASE_URL must be set in Render → Environment
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(helmet());
app.use(cors({ origin: '*', maxAge: 600 }));
app.use(express.json());

// helpful startup diagnostics
app.get('/healthz', async (req, res) => {
  try {
    const r = await pool.query('select 1 as ok');
    res.json({ ok: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET /fein-auth?leagueId=&teamId=&season=
app.get('/fein-auth', async (req, res) => {
  try {
    const { leagueId, teamId, season } = req.query;
    if (!leagueId || !teamId || !season) {
      return res.status(400).json({ ok: false, error: 'leagueId, teamId, season required' });
    }
    const q = `
      SELECT league_id, team_id, season, swid, espn_s2
      FROM public.fein_teams
      WHERE league_id = $1 AND team_id = $2 AND season = $3
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [leagueId, teamId, season]);
    const row = rows[0];
    if (!row?.swid || !row?.espn_s2) {
      return res.status(404).json({ ok: false, error: 'No creds found for that triple' });
    }
    res.json({ ok: true, leagueId: row.league_id, teamId: row.team_id, season: row.season, swid: row.swid, espn_s2: row.espn_s2 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // this line ensures the process stays alive and proves it started
  console.log(`fein-auth-service listening on :${PORT}`);
});

// safety: surface unhandled rejections so Render logs them
process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
  process.exit(1);
});
