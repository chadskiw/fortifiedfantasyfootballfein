// routes/espnconnect.js  — CommonJS, no ESM
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

function sha256(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex'); }
function nowIso()  { return new Date().toISOString(); }

function normalizeSwid(raw) {
  try {
    let v = decodeURIComponent(String(raw || '')).trim();
    if (!v) return '';
    v = v.replace(/^%7B/i, '{').replace(/%7D$/i, '}');
    if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
    return v.toUpperCase();
  } catch {
    return String(raw || '');
  }
}

function readCreds(req) {
  const h = req.headers || {};
  const c = req.cookies || {};
  const swid = normalizeSwid(h['x-espn-swid'] || c.SWID || c.swid || c.ff_espn_swid || req.query?.SWID || req.query?.swid);
  const s2   = h['x-espn-s2']   || c.espn_s2   || c.ESPN_S2      || c.ff_espn_s2    || req.query?.s2   || req.query?.espn_s2;
  return { swid, s2 };
}

async function fetchFan({ swid, s2 }) {
  if (!swid || !s2) throw Object.assign(new Error('missing_swid_or_s2'), { status: 400 });
  const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
  const r = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      cookie: `SWID=${swid}; espn_s2=${s2}`,
      referer: 'https://www.espn.com/'
    }
  });
  const txt = await r.text();
  if (!r.ok) throw Object.assign(new Error(`fan_upstream_${r.status}`), { status: r.status, body: txt });
  try {
    return JSON.parse(txt);
  } catch {
    throw Object.assign(new Error('fan_parse_error'), { status: 502, body: txt.slice(0, 200) });
  }
}

function buildFanMapForSeason(fanJson, season) {
  const out = new Map(); // leagueId -> entry object we care about
  const prefs = Array.isArray(fanJson?.preferences) ? fanJson.preferences : [];
  for (const p of prefs) {
    if (String(p?.type?.code || '').toLowerCase() !== 'fantasy') continue;
    const entry = p?.metaData?.entry;
    if (!entry) continue;
    const seasonId = Number(entry.seasonId);
    if (seasonId !== Number(season)) continue;

    const group = Array.isArray(entry.groups) && entry.groups[0] ? entry.groups[0] : null;
    const leagueId = group?.groupId ? String(group.groupId) : null;
    if (!leagueId) continue;

    const gameAbbrev = (entry.abbrev || entry.entryMetadata?.abbrev || '').toString().toUpperCase(); // e.g., FFL
    const teamId     = Number(entry.entryId);
    const teamName   = entry?.entryMetadata?.teamName || `Team ${teamId}`;
    const leagueName = group?.groupName || entry?.name || '';
    const leagueSize = Number(group?.groupSize || 0);

    const entryURL        = entry.entryURL || entry.entryUrl || '';
    const leagueURL       = group?.href || '';
    const fantasyCastHref = group?.fantasyCastHref || '';
    const scoreboardFeed  = entry.scoreboardFeedURL || entry.scoreboardFeedUrl || '';

    const logo = entry.logoUrl || entry.logoURL || '';
    out.set(leagueId, {
      season: Number(season),
      leagueId,
      teamId,
      game: gameAbbrev.toLowerCase(), // 'ffl' expected
      leagueName,
      leagueSize,
      teamName,
      teamLogo: logo,
      urls: {
        entryURL,
        leagueURL,
        fantasyCastHref,
        scoreboardFeed
      }
    });
  }
  return out;
}
const { fetchFromEspnWithCandidates } = require('./espn/espnCred');

async function hydrateFromEspn(req, { game='ffl', season, leagueId, teamId }) {
  try {
    const url = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
    url.searchParams.append('view', 'mTeam');
    url.searchParams.append('view', 'mSettings');
    const { status, body } = await fetchFromEspnWithCandidates(url.toString(), req, {
      leagueId: String(leagueId), teamId: String(teamId)
    });
    if (status < 200 || status >= 300) return null;
    const j = JSON.parse(body || '{}');
    const settings   = j.settings || {};
    const teams      = Array.isArray(j.teams) ? j.teams : [];
    const t          = teams.find(x => String(x.id) === String(teamId)) || null;
    const leagueName = settings.name || null;
    const leagueSize = teams.length || null;
    const teamName   = t?.name || t?.teamName || (t?.location && t?.nickname ? `${t.location} ${t.nickname}` : null);
    const teamLogo   = t?.logo || null;
    return { leagueName, leagueSize, teamName, teamLogo };
  } catch {
    return null;
  }
}

// ---------- DB helpers ----------

// upsertCred: use SWID as the conflict target
// routes/espnconnect.js
async function upsertCred(pool, { memberId, swid, espn_s2, ref }) {
  const sql = `
    INSERT INTO ff_espn_cred (member_id, swid, espn_s2, ref, last_seen)
    VALUES ($1,$2,$3,$4, NOW())
    ON CONFLICT (swid) DO UPDATE
      SET espn_s2=EXCLUDED.espn_s2,
          ref=EXCLUDED.ref,
          last_seen=NOW()
    RETURNING cred_id, member_id, swid;
  `;
  const vals = [memberId, String(swid).trim(), espn_s2, ref || 'espnconnect'];
  const { rows } = await pool.query(sql, vals);
  return rows[0];
}



// db/upsertSport.js
// upsert_sport.js
const TABLE_BY_SPORT = {
  ffl: 'ff_sport_ffl',
  flb: 'ff_sport_flb',
  fba: 'ff_sport_fba',
  fhl: 'ff_sport_fhl',
};

function tableForSport(sport) {
  const key = String(sport || '').toLowerCase();
  const table = TABLE_BY_SPORT[key];
  if (!table) throw new Error(`unsupported_sport: ${sport}`);
  return table;
}

async function upsertSport(pool, item) {
  const {
    sport, season, leagueId, teamId,
    leagueName = null, leagueSize = null,
    teamName = null, teamLogo = null,
    urls = {}
  } = item;

  if (!sport || !season || !leagueId || !teamId) return { inserted:0, updated:0, skipped:true };

  const table = tableForSport(sport);
  const platform = '018'; // keep consistent with your rows
  // normalize URL shapes from FE (entryURL, leagueURL, fantasyCastHref, scoreboardFeed)
  const entryUrl       = urls.entry       ?? urls.entryURL       ?? null;
  const leagueUrl      = urls.league      ?? urls.leagueURL      ?? null;
  const fantasycastUrl = urls.fantasycast ?? urls.fantasyCastHref?? null;
  const scoreboardUrl  = urls.scoreboard  ?? urls.scoreboardFeed ?? null;

  const args = [
    String(sport).toLowerCase(),  // $1 sport
    Number(season),               // $2 season
    String(leagueId),             // $3 league_id
    Number(teamId),               // $4 team_id
    platform,                     // $5 platform
    leagueName,                   // $6 league_name
    leagueSize,                   // $7 league_size
    teamName,                     // $8 team_name
    teamLogo,                     // $9 team_logo_url
    entryUrl,                     // $10 entry_url
    leagueUrl,                    // $11 league_url
    fantasycastUrl,               // $12 fantasycast_url
    scoreboardUrl,                // $13 scoreboard_url
    urls.signup ?? null           // $14 signup_url
  ];

  const updSql = `
    update ${table}
       set platform        = coalesce($5,  platform),
           league_name     = coalesce($6,  league_name),
           league_size     = coalesce($7,  league_size),
           team_name       = coalesce($8,  team_name),
           team_logo_url   = coalesce($9,  team_logo_url),
           entry_url       = coalesce($10, entry_url),
           league_url      = coalesce($11, league_url),
           fantasycast_url = coalesce($12, fantasycast_url),
           scoreboard_url  = coalesce($13, scoreboard_url),
           signup_url      = coalesce($14, signup_url),
           last_seen_at    = now()
     where sport           = $1
       and season          = $2
       and league_id::text = $3::text
       and team_id::int    = $4::int
     returning 1
  `;

  const u = await pool.query(updSql, args);
  if (u.rowCount > 0) return { inserted:0, updated:1, skipped:false };

  const insSql = `
    insert into ${table} (
      sport, season, league_id, team_id, platform,
      league_name, league_size, team_name, team_logo_url,
      entry_url, league_url, fantasycast_url, scoreboard_url, signup_url,
      first_seen_at, last_seen_at
    ) values (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      now(), now()
    )
    on conflict do nothing
    returning 1
  `;
  const i = await pool.query(insSql, args);
  return { inserted:i.rowCount, updated:0, skipped:false };
}

module.exports = { upsertSport };

async function upsertFfl(pool, item, sport ='ffl') {
  const {
    season, leagueId, teamId,
    leagueName = null, leagueSize = null,
    teamName = null, teamLogo = null,
    urls = {}
  } = item;

  if (!season || !leagueId || !teamId) return { inserted:0, updated:0, skipped:true };

  const updSql = `
    update ff_sport_${sport}
       set league_name     = coalesce($4, league_name),
           league_size     = coalesce($5, league_size),
           team_name       = coalesce($6, team_name),
           team_logo_url   = coalesce($7, team_logo_url),
           entry_url       = coalesce($8, entry_url),
           league_url      = coalesce($9, league_url),
           fantasycast_url = coalesce($10, fantasycast_url),
           scoreboard_url  = coalesce($11, scoreboard_url),
           last_seen_at    = now()
     where season = $1
       and league_id::text = $2::text
       and team_id::int    = $3::int
     returning 1
  `;
  const entry_url       = urls.entryURL || null;
  const league_url      = urls.leagueURL || null;
  const fantasycast_url = urls.fantasyCastHref || null;
  const scoreboard_url  = urls.scoreboardFeed || null;

  const upd = await pool.query(updSql, [
    Number(season), String(leagueId), Number(teamId),
    leagueName, leagueSize, teamName, teamLogo,
    entry_url, league_url, fantasycast_url, scoreboard_url
  ]);
  if (upd.rowCount) return { inserted:0, updated:1, skipped:false };

  const insSql = `
    insert into ff_sport_ffl
      (char_code, season, num_code, platform, league_id, team_id,
       league_name, league_size, team_name, team_logo_url,
       entry_url, league_url, fantasycast_url, scoreboard_url,
       in_season, is_live, current_scoring_period,
       first_seen_at, last_seen_at, visibility, status, source_payload)
    values
      ('ffl', $1, 1, '018', $2, $3,
       $4, $5, $6, $7,
       $8, $9, $10, $11,
       null, null, null,
       now(), now(), 'public', 'active', $12)
  `;
  const payload = item; // store the exact item we ingested
  await pool.query(insSql, [
    Number(season), String(leagueId), Number(teamId),
    leagueName, leagueSize, teamName, teamLogo,
    entry_url, league_url, fantasycast_url, scoreboard_url,
    payload
  ]);
  return { inserted:1, updated:0, skipped:false };
}



// ---------- ingest handler ----------

// expect: upsertSport(pool, item) from your updated helper
// optional: hydrateFromEspn(req, item) can accept { sport } too
async function ingestHandler(req, res) {
  try {
    const { season, swid, s2, items = [] } = req.body || {};
    const pool = req.app.get('pg');

    // Save ESPN cred if provided
    const cred = (swid && s2)
      ? await upsertCred(pool, { swid, s2, ref: 'espnconnect' })
      : { inserted: 0, updated: 0 };

    let leaguesAttempted = 0,
        leaguesSucceeded = 0,
        teamsInserted   = 0,
        teamsUpdated    = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok:false, error:'items_must_be_array' });
    }

    for (const raw of items) {
      leaguesAttempted++;
      try {
        // normalize + default sport
        const itm = {
          ...raw,
          // accept both "sport" and "game" from the client
          sport: (raw.sport || raw.game || 'ffl').toLowerCase(),
          season: Number(raw.season ?? season) || null
        };

        // backfill missing display fields from ESPN
        if (!itm.leagueName || !itm.leagueSize || !itm.teamName || !itm.teamLogo) {
          const h = await hydrateFromEspn(req, itm); // pass sport-aware item
          if (h) Object.assign(itm, h);
        }

        // upsert with sport-aware helper
        const r = await upsertSport(pool, itm);
        if (r?.skipped) continue;

        leaguesSucceeded += 1;
        teamsInserted    += r.inserted || 0;
        teamsUpdated     += r.updated  || 0;
      } catch (e) {
        // don’t blow up the whole batch; log and continue
        console.warn('[espnconnect ingest item failed]', { leagueId: raw?.leagueId, teamId: raw?.teamId, sport: raw?.sport || 'ffl' }, e?.message);
      }
    }

    return res.json({
      ok: true,
      season: Number(season) || null,
      summary: {
        leaguesAttempted,
        leaguesSucceeded,
        teamsInserted,
        teamsUpdated,
        credInserted: cred.inserted || 0,
        credUpdated:  cred.updated  || 0
      }
    });
  } catch (e) {
    console.error('[espnconnect ingest fatal]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

module.exports = require('express').Router()
  .post('/', ingestHandler)
  .post('/ingest', ingestHandler);


// ---------- routes ----------

// POST aliases
router.post('/', ingestHandler);
router.post('/ingest', ingestHandler);

// Optional: Fan proxy here too (safe dup with server-level handler)
router.get('/fan/me', async (req, res) => {
  try {
    const { swid, s2 } = readCreds(req);
    const fan = await fetchFan({ swid, s2 });
    res.set('Cache-Control', 'no-store');
    res.json(fan);
  } catch (e) {
    const status = Number(e.status || 500);
    res.status(status).json({ ok:false, error: e.message || 'fan_error' });
  }
});
router.get('/fan/:id', async (req, res) => {
  try {
    const s2 = readCreds(req).s2;
    const swid = normalizeSwid(req.params.id);
    const fan = await fetchFan({ swid, s2 });
    res.set('Cache-Control', 'no-store');
    res.json(fan);
  } catch (e) {
    const status = Number(e.status || 500);
    res.status(status).json({ ok:false, error: e.message || 'fan_error' });
  }
});

module.exports = router;
