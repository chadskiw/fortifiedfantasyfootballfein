// routes/espn-ingest.js
// Mounts under: /api/platforms/espn  (from server.js)
// Exposes:
//   POST /api/platforms/espn/ingest/espn/fan
//   GET  /api/platforms/espn/ingest/status

const express = require('express');
const crypto  = require('crypto');
// Use native fetch (Node 18+) with a lazy node-fetch fallback
const fetch   = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));
const pool    = require('../src/db/pool');

const router = express.Router();

// ESPN gameId → sport code (must match ff_sport_code_map + table names)
const GAME_ID_TO_SPORT = { 1: 'ffl', 2: 'flb', 3: 'fba', 4: 'fhl', 5: 'fwnba' };
const SPORT_TO_NUM = Object.fromEntries(Object.entries(GAME_ID_TO_SPORT).map(([n, s]) => [s, Number(n)]));

const isoFromMs = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const md5       = (s)  => crypto.createHash('md5').update(s || '').digest('hex');
const isUUID    = (s)  => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ''));
const isSwid    = (s)  => /^\{[0-9A-Fa-f-]{36}\}$/.test(String(s || ''));

// ---------- helpers ----------

function rowsFromFanJson(fan) {
  const rowsBySport = {};
  const prefs = Array.isArray(fan?.preferences) ? fan.preferences : [];
  for (const p of prefs) {
    if (p?.typeId !== 9) continue; // fantasy league entries only

    const md    = p.metaData || {};
    const entry = md.entry   || {};
    const g0    = Array.isArray(entry.groups) && entry.groups.length ? entry.groups[0] : {};

    const gameId = entry.gameId;
    const sport  = GAME_ID_TO_SPORT[gameId];
    if (!sport) continue;

    const season      = entry.seasonId ?? null;
    const leagueId    = g0.groupId ?? null;
    const leagueName  = g0.groupName || entry.name || null;
    const leagueSize  = g0.groupSize ?? null;

    const entryUrl = entry.entryURL || '';
    const teamId = (() => {
      const m = entryUrl.match(/[?&]teamId=(\d+)/);
      return m ? parseInt(m[1], 10) : (entry.entryId ?? null);
    })();

    const draftJson = {
      type:   g0.draftTypeName || null,
      status: g0.draftStatus ?? null,
      date:   isoFromMs(g0.draftDate),
    };

    const scoringJson = {
      scoringTypeName: entry.entryMetadata?.scoringTypeName ?? null,
      leagueTypeId:    entry.entryMetadata?.leagueTypeId ?? null,
      restriction:     entry.restrictionTypeName ?? null,
    };

    const payload = {
      entry_url:        entry.entryURL || null,
      league_url:       g0.href || null,
      fantasycast:      g0.fantasyCastHref || null,
      scoreboard_url:   entry.scoreboardFeedURL || null,
      signup_url:       entry.signupURL || null,
      raw_currentScoringPeriodId: md.currentScoringPeriodId ?? null,
    };

    const row = {
      platform: '018',
      season,
      league_id:    leagueId,
      team_id:      teamId,
      league_name:  leagueName,
      league_size:  leagueSize,
      team_name:    entry.entryMetadata?.teamName ?? null,
      handle:       entry.entryMetadata?.teamAbbrev ?? null,
      team_logo_url: entry.logoURL || entry.logoUrl || null,
      in_season:    !!md.inSeason,
      is_live:      !!md.isLive,
      current_scoring_period: md.currentScoringPeriodId ?? null,
      entry_url:     payload.entry_url,
      league_url:    payload.league_url,
      fantasycast_url: payload.fantasycast,
      scoreboard_url: payload.scoreboard_url,
      signup_url:      payload.signup_url,
      scoring_json:    scoringJson,
      draft_json:      draftJson,
      source_payload:  payload,
      source_etag:     null,
      visibility:      'public',
      status:          'active',
      source_hash:     md5((payload.entry_url || '') + (payload.scoreboard_url || '')),
      _sport:          sport,
    };

    (rowsBySport[sport] ||= []).push(row);
  }
  return rowsBySport;
}

async function upsertSportCodeMap(client, sport, gameId, label) {
  await client.query(
    `INSERT INTO ff_sport_code_map (char_code, num_code, label)
     VALUES ($1,$2,$3)
     ON CONFLICT (char_code) DO UPDATE
       SET num_code = EXCLUDED.num_code,
           label    = COALESCE(EXCLUDED.label, ff_sport_code_map.label)`,
    [sport, gameId, label]
  );
}

async function ensureSportTable(client, sport) {
  const table = `ff_sport_${sport}`;
  const ident = table.replace(/"/g, '""');
  const litSport = sport.replace(/'/g, "''");
  const num = SPORT_TO_NUM[sport] ?? null;

  await client.query(`CREATE TABLE IF NOT EXISTS "${ident}" (LIKE ff_sport INCLUDING ALL)`);

  // Make sure all runtime columns exist
  await client.query(`
    ALTER TABLE "${ident}"
      ADD COLUMN IF NOT EXISTS platform               text,
      ADD COLUMN IF NOT EXISTS season                 int,
      ADD COLUMN IF NOT EXISTS league_id              bigint,
      ADD COLUMN IF NOT EXISTS team_id                int,
      ADD COLUMN IF NOT EXISTS league_name            text,
      ADD COLUMN IF NOT EXISTS league_size            int,
      ADD COLUMN IF NOT EXISTS team_name              text,
      ADD COLUMN IF NOT EXISTS handle                 text,
      ADD COLUMN IF NOT EXISTS team_logo_url          text,
      ADD COLUMN IF NOT EXISTS in_season              boolean,
      ADD COLUMN IF NOT EXISTS is_live                boolean,
      ADD COLUMN IF NOT EXISTS current_scoring_period int,
      ADD COLUMN IF NOT EXISTS entry_url              text,
      ADD COLUMN IF NOT EXISTS league_url             text,
      ADD COLUMN IF NOT EXISTS fantasycast_url        text,
      ADD COLUMN IF NOT EXISTS scoreboard_url         text,
      ADD COLUMN IF NOT EXISTS signup_url             text,
      ADD COLUMN IF NOT EXISTS scoring_json           jsonb DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS draft_json             jsonb,
      ADD COLUMN IF NOT EXISTS source_payload         jsonb DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS reaction_counts        jsonb DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS source_hash            text,
      ADD COLUMN IF NOT EXISTS source_etag            text,
      ADD COLUMN IF NOT EXISTS visibility             text,
      ADD COLUMN IF NOT EXISTS status                 text,
      ADD COLUMN IF NOT EXISTS updated_at             timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS last_synced_at         timestamptz
  `);

  // Ensure char_code/num_code defaults so NOT NULL is satisfied by default
  await client.query(`ALTER TABLE "${ident}" ALTER COLUMN char_code SET DEFAULT '${litSport}'`);
  await client.query(`UPDATE "${ident}" SET char_code='${litSport}' WHERE char_code IS NULL`);

  if (num != null) {
    await client.query(`ALTER TABLE "${ident}" ALTER COLUMN num_code SET DEFAULT ${num}`);
    await client.query(`UPDATE "${ident}" SET num_code=${num} WHERE num_code IS NULL`);
  }

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${ident}_unique ON "${ident}" (season, platform, league_id, team_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${ident}_idx_platform_league ON "${ident}" (platform, league_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${ident}_gin_source_payload ON "${ident}" USING GIN (source_payload jsonb_path_ops)`);

  return table;
}



function buildUpsertSQL(table) {
  return `
    INSERT INTO "${table}" (
      char_code, num_code,
      platform, season, league_id, team_id,
      league_name, league_size, team_name, handle, team_logo_url,
      in_season, is_live, current_scoring_period,
      entry_url, league_url, fantasycast_url, scoreboard_url, signup_url,
      scoring_json, draft_json, source_payload,
      source_hash, source_etag, visibility, status,
      updated_at, last_synced_at
    )
    VALUES (
      $1,$2,
      $3,$4,$5,$6,
      $7,$8,$9,$10,$11,
      $12,$13,$14,
      $15,$16,$17,$18,$19,
      $20,$21,$22,
      $23,$24,$25,$26,
      now(), now()
    )
    ON CONFLICT (season, platform, league_id, team_id)
    DO UPDATE SET
      league_name            = EXCLUDED.league_name,
      league_size            = EXCLUDED.league_size,
      team_name              = EXCLUDED.team_name,
      handle                 = EXCLUDED.handle,
      team_logo_url          = EXCLUDED.team_logo_url,
      in_season              = EXCLUDED.in_season,
      is_live                = EXCLUDED.is_live,
      current_scoring_period = EXCLUDED.current_scoring_period,
      entry_url              = EXCLUDED.entry_url,
      league_url             = EXCLUDED.league_url,
      fantasycast_url        = EXCLUDED.fantasycast_url,
      scoreboard_url         = EXCLUDED.scoreboard_url,
      signup_url             = EXCLUDED.signup_url,
      scoring_json           = EXCLUDED.scoring_json,
      draft_json             = EXCLUDED.draft_json,
      source_payload         = EXCLUDED.source_payload,
      source_hash            = EXCLUDED.source_hash,
      source_etag            = EXCLUDED.source_etag,
      visibility             = EXCLUDED.visibility,
      status                 = EXCLUDED.status,
      updated_at             = now(),
      last_synced_at         = now()
  `;
}


// ---------- routes ----------

router.post('/ingest/espn/fan', async (req, res) => {
  try {
    const h = req.headers || {};
    const c = req.cookies || {};

    const swid = (h['x-espn-swid'] || h['swid'] || c.SWID || c.swid || req.body?.swid || '').trim();
    const s2   = (h['x-espn-s2']   || h['espn_s2'] || h['s2'] || c.ESPN_S2 || c.espn_s2 || req.body?.s2 || '').trim();

    if (!isSwid(swid) || !s2) {
      return res.status(400).json({ ok:false, error:'missing_or_invalid_swid_or_s2' });
    }

    // Member id (from session or explicit)
const memberIdRaw =
  (req.user && req.user.id) ||
  req.body?.member_id ||
  req.query?.member_id ||
  h['x-fein-key'] || '';
const memberId = isUUID(memberIdRaw) ? memberIdRaw : null;

    // Use pre-fetched fan payload if present; otherwise fetch from ESPN
    let fan = req.body?.fan;
    if (!fan) {
      const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
      const fanRes = await fetch(url, {
        headers: {
          Cookie: `SWID=${swid}; ESPN_S2=${s2}`,
          'User-Agent': 'ff-platform/1.0',
          Accept: 'application/json',
        },
      });
      if (!fanRes.ok) {
        return res.status(fanRes.status).json({ ok:false, error:'espn_fetch_failed' });
      }
      fan = await fanRes.json();
    }

    const rowsBySport = rowsFromFanJson(fan);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Credentials upsert
let cred;

if (memberId) {
  // Normal path when we have a UUID
  try {
    const r = await client.query(
      'SELECT * FROM ff_espn_cred_merge($1::text,$2::text,$3::uuid)',
      [swid, s2, memberId]
    );
    cred = r.rows[0];
  } catch {
    const r = await client.query(
      'SELECT * FROM ff_espn_cred_upsert($1::text,$2::text,$3::uuid)',
      [swid, s2, memberId]
    );
    cred = r.rows[0];
  }
} else {
  // No UUID available: upsert by SWID only
  const r = await client.query(
    `INSERT INTO ff_espn_cred (swid, espn_s2, first_seen, last_seen)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (swid) DO UPDATE
       SET espn_s2 = EXCLUDED.espn_s2,
           last_seen = now()
     RETURNING *`,
    [swid, s2]
  );
  cred = r.rows[0];
}


      // 2) Ensure code map entries
      for (const [sport] of Object.entries(rowsBySport)) {
        const gameId = Number(Object.keys(GAME_ID_TO_SPORT).find(k => GAME_ID_TO_SPORT[k] === sport) || 0);
        const pretty = { ffl:'Fantasy Football', flb:'Fantasy Baseball', fba:'Fantasy Basketball', fhl:'Fantasy Hockey', fwnba:'Fantasy WNBA' }[sport] || `Fantasy ${sport.toUpperCase()}`;
        await upsertSportCodeMap(client, sport, gameId, pretty);
      }

      // 3) Ensure per-sport tables + upsert rows
      const results = {};
      for (const [sport, rows] of Object.entries(rowsBySport)) {
        const table = await ensureSportTable(client, sport);
        const sql   = buildUpsertSQL(table);

        let processed = 0;
        for (const r of rows) {
const sportNum = SPORT_TO_NUM[sport] ?? null;

await client.query(sql, [
  // $1..$2
  sport, sportNum,
  // $3..$26
  r.platform, r.season, r.league_id, r.team_id,
  r.league_name, r.league_size, r.team_name, r.handle, r.team_logo_url,
  r.in_season, r.is_live, r.current_scoring_period,
  r.entry_url, r.league_url, r.fantasycast_url, r.scoreboard_url, r.signup_url,
  r.scoring_json, r.draft_json, r.source_payload,
  r.source_hash, r.source_etag, r.visibility, r.status,
]);

          processed++;
        }
        results[sport] = { table, rows: rows.length, processed };
      }

      await client.query('COMMIT');
      return res.json({ ok:true, cred, results });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[espn-ingest] tx error', e);
      return res.status(500).json({ ok:false, error:'ingest_failed' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[espn-ingest] handler error', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// health/status for quick smoke test
router.get('/ingest/status', (_req, res) => res.json({ ok:true, routes:['POST /ingest/espn/fan'] }));

module.exports = router;
