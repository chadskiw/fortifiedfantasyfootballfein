// routes/espn-ingest.js
// Mount: app.use('/api/platforms/espn', require('./routes/espn-ingest'));
const express = require('express');

// ---- DB pool ----
let db = require('../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[espn-ingest] pg pool missing/invalid import');
}

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: false }));

/* ---------------- helpers ---------------- */
const ESPN_PLATFORM_CODE = '018';
const log = (...a) => console.log('[espn-ingest]', ...a);
const safeIdent = (s) => {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return v || 'unk';
};
const padNum = (v, len) => String(v ?? '').replace(/\D+/g, '').padStart(len, '0').slice(-len);

// keep 24-char SID layout, but if your teamIds exceed 2 digits often, revisit this
function sportTo3DigitCodeFlex(code, offsets = [0, 36, 144, 81, 121, 49, 100]) {
  const letters = String(code || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, offsets.length);
  if (!letters) return '000';
  let prod = 1;
  for (let i = 0; i < letters.length; i++) prod *= (letters.charCodeAt(i) - 96) + (offsets[i] || 0);
  const val = Math.ceil(Math.sqrt(prod));
  return String(val % 1000).padStart(3, '0');
}
function computeSid24({ season, platformCode, leagueId, teamId, sportCode }) {
  const season4 = padNum(season, 4);
  const plat3   = padNum(platformCode, 3);
  const lg12    = padNum(leagueId, 12);
  const tm2     = padNum(teamId, 2);
  const sp3     = sportTo3DigitCodeFlex(sportCode);
  return season4 + plat3 + lg12 + tm2 + sp3;
}
function detectCharCode(entry) {
  if (entry?.abbrev) return String(entry.abbrev).toLowerCase();
  const url = entry?.scoreboardFeedURL || entry?.scoreboardFeedUrl || '';
  let m = /\/games\/([a-z0-9_]{2,})\//i.exec(url);
  if (m) return m[1].toLowerCase();
  const u = entry?.entryURL || entry?.entryUrl || entry?.href || '';
  m = /fantasy\.[^/]+\/([a-z0-9_]+)/i.exec(u);
  if (m && m[1].length <= 6) return m[1].toLowerCase();
  if (entry?.gameId != null) return `g${String(entry.gameId).replace(/\D+/g, '')}`;
  return 'unk';
}
async function fetchFanJson({ swid, s2 }) {
  const fanUrl = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
  const resp = await fetch(fanUrl, {
    headers: {
      accept: 'application/json',
      cookie: `SWID=${swid}; espn_s2=${encodeURIComponent(s2)}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const msg = `espn_fetch_failed ${resp.status} ${text.slice(0, 180)}`;
    throw new Error(msg);
  }
  return resp.json();
}

/* ---------------- schema helpers ---------------- */
async function ensureCatalogTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_sport_code_map (
      char_code text PRIMARY KEY,
      num_code  int UNIQUE NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ff_sport (
      char_code            text NOT NULL,
      season               int  NOT NULL,
      num_code             int  NOT NULL,
      table_name           text NOT NULL,
      total_count          int  NOT NULL DEFAULT 0,
      unique_sid_count     int  NOT NULL DEFAULT 0,
      unique_member_count  int  NOT NULL DEFAULT 0,
      last_seen_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (char_code, season)
    )
  `);
}

async function ensureNumCode(charCode) {
  const q1 = await pool.query('SELECT num_code FROM ff_sport_code_map WHERE char_code=$1', [charCode]);
  if (q1.rows[0]) return q1.rows[0].num_code;
  const q2 = await pool.query('SELECT COALESCE(MAX(num_code),0)+1 AS n FROM ff_sport_code_map');
  const num = q2.rows[0].n;
  await pool.query(
    'INSERT INTO ff_sport_code_map (char_code, num_code) VALUES ($1,$2) ON CONFLICT (char_code) DO NOTHING',
    [charCode, num]
  );
  return num;
}

async function ensureSportTable(charCode) {
  const code = safeIdent(charCode);
  const table = `ff_sport_${code}`;

  // split DDL into separate calls for compatibility
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table}(
      sid                text PRIMARY KEY,
      member_id          text NOT NULL,
      season             int  NOT NULL,
      platform           text NOT NULL DEFAULT 'espn',
      league_id          text NOT NULL,
      team_id            text NOT NULL,
      league_name        text,
      owner_name         text,
      team_abbrev        text,
      team_logo_url      text,
      league_logo_url    text,
      group_size         int,
      group_manager      boolean,
      scoring_type_id    int,
      league_type_id     int,
      league_sub_type_id int,
      format_type_id     int,
      in_season          boolean,
      is_live            boolean,
      current_scoring_period int,
      draft_date         timestamptz,
      fantasy_urls       jsonb,
      last_synced_at     timestamptz NOT NULL DEFAULT now(),
      source_etag        text,
      source_hash        text,
      source_payload     jsonb,
      visibility         text,
      status             text,
      swid               text,
      espn_s2            text
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_season_idx ON ${table}(season)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_league_idx ON ${table}(season, league_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_member_idx ON ${table}(member_id, season)`);
  return table;
}

async function refreshSportCatalog({ charCode, season, tableName }) {
  const numCode = await ensureNumCode(charCode);
  const { rows: [s] } = await pool.query(`
    SELECT COUNT(*)::int AS total_count,
           COUNT(DISTINCT sid)::int AS unique_sid_count,
           COUNT(DISTINCT member_id)::int AS unique_member_count
      FROM ${tableName}
     WHERE season=$1
  `, [season]);
  await pool.query(`
    INSERT INTO ff_sport (char_code, season, num_code, table_name, total_count, unique_sid_count, unique_member_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (char_code, season) DO UPDATE
      SET num_code=$3, table_name=$4, total_count=$5,
          unique_sid_count=$6, unique_member_count=$7, last_seen_at=now()
  `, [charCode, season, numCode, tableName, s?.total_count || 0, s?.unique_sid_count || 0, s?.unique_member_count || 0]);
}

async function upsertSportRows(tableName, rows) {
  if (!rows?.length) return;
  const cols = [
    'sid','member_id','season','platform','league_id','team_id',
    'league_name','owner_name','team_abbrev','team_logo_url','league_logo_url',
    'group_size','group_manager','scoring_type_id','league_type_id','league_sub_type_id','format_type_id',
    'in_season','is_live','current_scoring_period','draft_date','fantasy_urls',
    'last_synced_at','source_etag','source_hash','source_payload','visibility','status','swid','espn_s2'
  ];
  const params = [];
  const values = [];
  let p = 1;
  for (const r of rows) {
    values.push(`(${cols.map(() => `$${p++}`).join(',')})`);
    params.push(
      r.sid,
      r.member_id,
      r.season,
      'espn',
      String(r.league_id),
      String(r.team_id),
      r.league_name || null,
      r.owner_name || null,
      r.team_abbrev || null,
      r.team_logo_url || null,
      r.league_logo_url || null,
      r.group_size ?? null,
      r.group_manager ?? null,
      r.scoring_type_id ?? null,
      r.league_type_id ?? null,
      r.league_sub_type_id ?? null,
      r.format_type_id ?? null,
      r.in_season ?? null,
      r.is_live ?? null,
      r.current_scoring_period ?? null,
      r.draft_date ? new Date(Number(r.draft_date)).toISOString() : null,
      r.fantasy_urls ? JSON.stringify(r.fantasy_urls) : null,            // <-- stringify jsonb
      r.last_synced_at || new Date().toISOString(),
      r.source_etag || null,
      r.source_hash || null,
      r.source_payload ? JSON.stringify(r.source_payload) : null,        // <-- stringify jsonb
      r.visibility || null,
      r.status || null,
      r.swid || null,
      r.espn_s2 || null
    );
  }
  await pool.query(`
    INSERT INTO ${tableName} (${cols.join(',')})
    VALUES ${values.join(',')}
    ON CONFLICT (sid) DO UPDATE SET
      member_id              = EXCLUDED.member_id,
      league_name            = EXCLUDED.league_name,
      owner_name             = EXCLUDED.owner_name,
      team_abbrev            = EXCLUDED.team_abbrev,
      team_logo_url          = EXCLUDED.team_logo_url,
      league_logo_url        = EXCLUDED.league_logo_url,
      group_size             = EXCLUDED.group_size,
      group_manager          = EXCLUDED.group_manager,
      scoring_type_id        = EXCLUDED.scoring_type_id,
      league_type_id         = EXCLUDED.league_type_id,
      league_sub_type_id     = EXCLUDED.league_sub_type_id,
      format_type_id         = EXCLUDED.format_type_id,
      in_season              = EXCLUDED.in_season,
      is_live                = EXCLUDED.is_live,
      current_scoring_period = EXCLUDED.current_scoring_period,
      draft_date             = EXCLUDED.draft_date,
      fantasy_urls           = EXCLUDED.fantasy_urls,
      last_synced_at         = EXCLUDED.last_synced_at,
      source_etag            = EXCLUDED.source_etag,
      source_hash            = EXCLUDED.source_hash,
      source_payload         = EXCLUDED.source_payload,
      visibility            = EXCLUDED.visibility,
      status                 = EXCLUDED.status
  `, params);
}

function extractRowsFromChuiAll({ chui, minSeason, member_id, swid, s2 }) {
  const prefs = Array.isArray(chui?.preferences) ? chui.preferences : [];
  const out = {};
  for (const p of prefs) {
    const t = p?.type || {};
    if (!(p?.metaData?.entry) || !(t?.id === 9 || t?.code === 'fantasy')) continue;

    const e = p.metaData.entry;
    const season = Number(e?.seasonId);
    if (!Number.isFinite(season) || season < minSeason) continue;

    const charCode = safeIdent(detectCharCode(e));   // <-- ensure identifier safe
    const teamId = e?.entryId;
    const teamName = e?.entryMetadata?.teamName || null;
    const teamAbbrev = e?.entryMetadata?.teamAbbrev || null;
    const leagueLogo = e?.logoURL || e?.logoUrl || null;
    const teamLogo = e?.logoUrl || e?.logoURL || null;

    const baseUrls = {
      league     : e?.groups?.[0]?.href || null,
      team       : e?.entryURL || e?.entryUrl || null,
      fantasycast: e?.groups?.[0]?.fantasyCastHref || null,
      scoreboard : e?.scoreboardFeedURL || e?.scoreboardFeedUrl || null
    };

    const flags = {
      format_type_id         : e?.entryMetadata?.leagueFormatTypeId ?? null,
      league_sub_type_id     : e?.entryMetadata?.leagueSubTypeId ?? null,
      scoring_type_id        : e?.entryMetadata?.scoringTypeId ?? null,
      league_type_id         : e?.entryMetadata?.leagueTypeId ?? null,
      in_season              : !!e?.inSeason,
      is_live                : !!e?.isLive,
      current_scoring_period : e?.currentScoringPeriodId ?? null
    };

    const groups = Array.isArray(e?.groups) ? e.groups : [];
    for (const g of groups) {
      const gid = g?.groupId;
      if (gid == null) continue;

      const sid = computeSid24({
        season, platformCode: ESPN_PLATFORM_CODE, leagueId: gid, teamId, sportCode: charCode
      });

      const row = {
        sid,
        member_id: member_id || null,
        season,
        league_id: gid,
        team_id: teamId,
        league_name: g?.groupName || e?.name || null,
        owner_name: teamName,
        team_abbrev: teamAbbrev,
        team_logo_url: teamLogo,
        league_logo_url: leagueLogo,
        group_size: g?.groupSize ?? null,
        group_manager: !!g?.groupManager,
        draft_date: g?.draftDate ? Number(g.draftDate) : null,
        ...flags,
        fantasy_urls: baseUrls,
        last_synced_at: new Date().toISOString(),
        swid: swid || null,
        espn_s2: s2 || null,
        source_payload: p
      };

      (out[charCode] ||= []).push(row);
    }
  }
  return out;
}

/* --------------- routes --------------- */

// Health check
router.get('/ingest/ping', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_error', message: e.message });
  }
});

// Dry-run preview (no DB writes) to debug payload carve
router.get('/ingest/preview', async (req, res) => {
  try {
    const cookies = req.cookies || {};
    const swid = (req.get('x-espn-swid') || cookies.ff_espn_swid || cookies.SWID || '').trim();
    const s2   = (req.get('x-espn-s2')   || cookies.ff_espn_s2   || cookies.espn_s2 || cookies.ESPN_S2 || '').trim();
    const minSeason = Number(req.query.minSeason) || new Date().getFullYear();
    const member_id = (cookies.ff_member || '').trim().toUpperCase() || null;

    if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_espn_creds' });

    const chui = await fetchFanJson({ swid, s2 });
    const grouped = extractRowsFromChuiAll({ chui, minSeason, member_id, swid, s2 });

    const summary = Object.fromEntries(Object.entries(grouped).map(([k,v]) => [k, v.length]));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, minSeason, member_id, summary, sample: Object.fromEntries(Object.entries(grouped).map(([k,v])=>[k, v[0]])) });
  } catch (e) {
    res.status(500).json({ ok:false, error:'preview_failed', message: e.message });
  }
});

// POST /api/platforms/espn/ingest
router.post('/ingest', async (req, res) => {
  try {
    const minSeason = Number(req.body?.minSeason) || new Date().getFullYear();
    const cookies = req.cookies || {};
    const member_id = (cookies.ff_member || '').trim().toUpperCase() || null;

    // Prefer new names, fall back to legacy:
    const swid = (req.body?.swid || req.get('x-espn-swid') || cookies.ff_espn_swid || cookies.SWID || '').trim();
    const s2   = (req.body?.s2   || req.get('x-espn-s2')   || cookies.ff_espn_s2   || cookies.espn_s2 || cookies.ESPN_S2 || '').trim();

    if (!swid || !s2) {
      log('missing_espn_creds', { swid: !!swid, s2: !!s2 });
      return res.status(400).json({ ok: false, error: 'missing_espn_creds' });
    }

    log('fetching Fan API…', { minSeason, member_id: member_id || null });

    const chui = await fetchFanJson({ swid, s2 });

    await ensureCatalogTables();
    const grouped = extractRowsFromChuiAll({ chui, minSeason, member_id, swid, s2 });

    const results = {};
    for (const charCodeRaw of Object.keys(grouped)) {
      const tableName = await ensureSportTable(charCodeRaw);
      const rows = grouped[charCodeRaw];
      log('upserting', { charCode: charCodeRaw, tableName, count: rows.length });
      await upsertSportRows(tableName, rows);
      await refreshSportCatalog({ charCode: charCodeRaw, season: minSeason, tableName });
      results[charCodeRaw] = rows.length;
    }

    return res.json({ ok: true, minSeason, member_id, wrote: results, sports: Object.keys(results).sort() });
  } catch (e) {
    console.error('[espn-ingest] server_error', e);
    return res.status(500).json({ ok: false, error: 'server_error', message: e.message });
  }
});

// Pass-through legacy leagues endpoint (optional)
router.get('/leagues', async (req, res, next) => {
  try {
    const u = new URL(req.protocol + '://' + req.get('host') + '/api/espn/leagues');
    for (const [k,v] of Object.entries(req.query)) u.searchParams.set(k, v);
    const r = await fetch(u, { headers: { 'accept': 'application/json', cookie: req.headers.cookie || '' } });
    res.status(r.status);
    res.set('Cache-Control', 'no-store');
    res.send(await r.text());
  } catch (e) {
    next(e);
  }
});

// Minimal cred probe
router.get('/cred', (req, res) => {
  const c = req.cookies || {};
  const swid = c.SWID || c.ff_espn_swid || null;
  const s2   = c.espn_s2 || c.ff_espn_s2 || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, hasCookies: !!(swid && s2), swid: !!swid, s2: !!s2, hasEspn: !!(swid && s2) });
});

module.exports = router;
