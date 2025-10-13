// routes/espnconnect.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookie = require('cookie');

const router = express.Router();
router.use(express.json());

// allow preflight so we never 405 on OPTIONS
router.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': 'https://fortifiedfantasy.com',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key'
  });
  res.sendStatus(204);
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

// ---- helpers
const sha256 = (s='') => crypto.createHash('sha256').update(String(s)).digest('hex');
const normSwid = (raw='') => {
  let v = String(raw).trim();
  try { v = decodeURIComponent(v); } catch {}
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
};
const readCreds = (req, body={}) => {
  const c = cookie.parse(req.headers.cookie || '');
  const swid = normSwid(body.swid || req.headers['x-espn-swid'] || c.SWID || c.swid || '');
  const s2   = body.s2 || req.headers['x-espn-s2'] || c.espn_s2 || c.s2 || '';
  return { swid, s2 };
};

// ---- POST /api/espnconnect/ingest  (note: path is RELATIVE; we mount with prefix)
router.post('/ingest', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const season = Number(req.body?.season) || new Date().getUTCFullYear();
    const { swid, s2 } = readCreds(req, req.body || {});

    // items[] preferred; else accept leagueIds/leagues
    let items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      const ids = req.body?.leagueIds || req.body?.leagues || [];
      items = ids.map(id => ({ season, leagueId: Number(id), teamId: null, game: 'ffl' }));
    }
    items = items
      .map(i => ({
        season: Number(i.season || season),
        leagueId: Number(i.leagueId),
        teamId: i.teamId == null ? null : Number(i.teamId),
        game: String(i.game || 'ffl').toLowerCase(),
      }))
      .filter(i => i.season && i.leagueId && i.game === 'ffl');

    if (!swid || !s2) {
      return res.status(409).json({
        ok: false, error: 'missing_input', detail: 'SWID and s2 are required',
        season, received: { swid: !!swid, s2: !!s2, items: items.length },
      });
    }
    if (!items.length) {
      return res.status(409).json({
        ok: false, error: 'missing_input', detail: 'No leagues/items to ingest',
        season, received: { swid: true, s2: true, items: 0 },
      });
    }

    const swid_hash = sha256(swid);
    const s2_hash   = sha256(s2);

    const client = await pool.connect();
    let leaguesAttempted = 0, leaguesSucceeded = 0, teamsInserted = 0, teamsUpdated = 0;

    try {
      await client.query('BEGIN');

      // ff_espn_cred upsert (manual, prefix-friendly)
      const existing = await client.query(
        'SELECT cred_id FROM ff_espn_cred WHERE swid_hash = $1 FOR UPDATE',
        [swid_hash]
      );
      if (existing.rowCount) {
        await client.query(
          `UPDATE ff_espn_cred
             SET swid=$2, espn_s2=$3, s2_hash=$4, last_seen=now(), ref='espnconnect'
           WHERE cred_id=$1`,
          [existing.rows[0].cred_id, swid, s2, s2_hash]
        );
      } else {
        await client.query(
          `INSERT INTO ff_espn_cred
             (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
           VALUES ($1,$2,$3,$4,NULL, now(), now(), 'espnconnect')`,
          [swid, s2, swid_hash, s2_hash]
        );
      }

      // ff_sport_ffl upsert per league
      for (const it of items) {
        leaguesAttempted++;
        try {
          const row = await client.query(
            `SELECT league_id FROM ff_sport_ffl
              WHERE char_code='ffl' AND season=$1 AND league_id=$2 FOR UPDATE`,
            [it.season, it.leagueId]
          );
          if (row.rowCount) {
            await client.query(
              `UPDATE ff_sport_ffl
                  SET team_id = COALESCE($3, team_id),
                      last_seen_at = now(),
                      updated_at = now()
                WHERE char_code='ffl' AND season=$1 AND league_id=$2`,
              [it.season, it.leagueId, it.teamId]
            );
            teamsUpdated++;
          } else {
            await client.query(
              `INSERT INTO ff_sport_ffl
                 (char_code, season, league_id, team_id, first_seen_at, last_seen_at, status, visibility)
               VALUES ('ffl', $1, $2, $3, now(), now(), 'active', 'public')`,
              [it.season, it.leagueId, it.teamId]
            );
            teamsInserted++;
          }
          leaguesSucceeded++;
        } catch (e) {
          console.error('[espnconnect/ingest league] fail', it, e.message);
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.status(200).json({
      ok: true,
      season,
      received: { swid: true, s2: true, items: items.length },
      summary: { leaguesAttempted, leaguesSucceeded, teamsInserted, teamsUpdated },
    });
  } catch (err) {
    console.error('[espnconnect/ingest] error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
