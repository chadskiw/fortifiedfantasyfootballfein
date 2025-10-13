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

// ---------- DB helpers ----------

async function upsertCred(pool, { swid, s2, memberId = null, ref = 'espnconnect' }) {
  if (!swid || !s2) return { inserted: 0, updated: 0 };

  const swidHash = sha256(swid);
  const s2Hash   = sha256(s2);

  // Does a cred for this SWID already exist?
  const { rows } = await pool.query(
    'select cred_id, ref from ff_espn_cred where swid_hash = $1 limit 1',
    [swidHash]
  );

  if (rows.length) {
    // Update S2 and last_seen; DO NOT overwrite ref (write-once); only backfill if NULL
    await pool.query(
      `update ff_espn_cred
          set espn_s2   = $1,
              s2_hash   = $2,
              last_seen = now(),
              ref       = coalesce(ref, $3)
        where swid_hash = $4`,
      [s2, s2Hash, ref, swidHash]
    );
    return { inserted: 0, updated: 1 };
  }

  // Insert new cred with ref
  await pool.query(
    `insert into ff_espn_cred
      (swid, espn_s2, swid_hash, s2_hash, member_id, first_seen, last_seen, ref)
     values ($1,  $2,     $3,       $4,     $5,        now(),     now(),   $6)`,
    [swid, s2, swidHash, s2Hash, memberId, ref]
  );
  return { inserted: 1, updated: 0 };
}

async function upsertFfl(pool, item) {
  const {
    season, leagueId, teamId,
    leagueName = null, leagueSize = null,
    teamName = null, teamLogo = null,
    urls = {}
  } = item;

  if (!season || !leagueId || !teamId) return { inserted: 0, updated: 0, skipped: true };

  const entry_url       = urls.entryURL || null;
  const league_url      = urls.leagueURL || null;
  const fantasycast_url = urls.fantasyCastHref || null;
  const scoreboard_url  = urls.scoreboardFeed || null;

  // 1) Try UPDATE first (robust to column types by casting)
  const updSql = `
    update ff_sport_ffl
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
     returning 1;
  `;
  const upd = await pool.query(updSql, [
    Number(season), String(leagueId), Number(teamId),
    leagueName, leagueSize, teamName, teamLogo,
    entry_url, league_url, fantasycast_url, scoreboard_url
  ]);

  if (upd.rowCount > 0) {
    return { inserted: 0, updated: 1, skipped: false };
  }

  // 2) If no row updated, INSERT a new one
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
  const payload = {
    season,
    leagueId,
    teamId,
    leagueName,
    leagueSize,
    teamName,
    teamLogo,
    urls
  };
  await pool.query(insSql, [
    Number(season), String(leagueId), Number(teamId),
    leagueName, leagueSize, teamName, teamLogo,
    entry_url, league_url, fantasycast_url, scoreboard_url,
    payload
  ]);

  return { inserted: 1, updated: 0, skipped: false };
}


// ---------- ingest handler ----------

async function ingestHandler(req, res) {
  const pool = req.app.get('pg');
  res.set('Cache-Control', 'no-store');

  try {
    const season = Number(req.body?.season || req.query?.season || new Date().getUTCFullYear());
    const { swid, s2 } = readCreds(req);

    // Upsert cred first (write-once ref preserved)
    const credSummary = await upsertCred(pool, { swid, s2, memberId: null, ref: 'espnconnect' });

    // Figure the selected leagues
    let items = Array.isArray(req.body?.items) ? req.body.items.slice() : [];
    const leagueIds = (Array.isArray(req.body?.leagues) ? req.body.leagues :
                      Array.isArray(req.body?.leagueIds) ? req.body.leagueIds : [])
                      .map(String);

    // If only IDs were sent, enrich from the Fan API
    let fanMap = null;
    if (!items.length && leagueIds.length) {
      const fan = await fetchFan({ swid, s2 });
      fanMap = buildFanMapForSeason(fan, season);
      for (const id of leagueIds) {
        const e = fanMap.get(String(id));
        if (e) items.push(e);
      }
    }

    // If items were sent but missing teamId / names, also enrich from Fan API
    if (items.length && items.some(i => !i.teamId)) {
      if (!fanMap) {
        const fan = await fetchFan({ swid, s2 });
        fanMap = buildFanMapForSeason(fan, season);
      }
      items = items.map(i => {
        if (i.teamId) return i;
        const fallback = fanMap.get(String(i.leagueId)) || {};
        return { ...fallback, ...i, teamId: i.teamId || fallback.teamId };
      });
    }

    // Only handle FFL for now (per your note); ignore others safely
    items = items.filter(i => String(i.game || 'ffl').toLowerCase() === 'ffl');

    const summary = {
      leaguesAttempted: items.length,
      leaguesSucceeded: 0,
      teamsInserted: 0,
      teamsUpdated: 0,
      credInserted: credSummary.inserted,
      credUpdated:  credSummary.updated
    };

    for (const it of items) {
      const r = await upsertFfl(pool, {
        season,
        leagueId: it.leagueId,
        teamId:   it.teamId,
        leagueName: it.leagueName || it.groupName,
        leagueSize: it.leagueSize || it.groupSize,
        teamName:   it.teamName,
        teamLogo:   it.teamLogo,
        urls: it.urls || {
          entryURL:        it.entryURL,
          leagueURL:       it.leagueURL || it.href,
          fantasyCastHref: it.fantasyCastHref,
          scoreboardFeed:  it.scoreboardFeedURL || it.scoreboardFeedUrl
        }
      });

      if (!r.skipped) {
        summary.leaguesSucceeded += 1;
        summary.teamsInserted += r.inserted;
        summary.teamsUpdated  += r.updated;
      }
    }

    return res.json({ ok: true, ts: nowIso(), season, summary });
  } catch (err) {
    console.error('[espnconnect ingest fatal]', err);
    const status = Number(err.status || 500);
    return res.status(status).json({ ok: false, error: err.message || 'server_error' });
  }
}

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
