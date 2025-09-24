// src/api/platforms/espn-ingest.js
// Creates per-sport tables (ff_sport_ffl, _flb, etc) and ingests ESPN “Fan API” data
// Usage examples are at the bottom of this message.

const express = require('express');

// Node 18+ has global fetch. If you’re on older Node, uncomment:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const router = express.Router();
module.exports = function createEspnIngestRouter(pool) {
  router.use(express.json({ limit: '2mb' }));

  // ---------- helpers ----------
  const ESPN_PLATFORM_CODE = '018'; // 3-digit code used in our synthetic SID

  const padNum = (v, len) =>
    String(v ?? '').replace(/\D+/g, '').padStart(len, '0').slice(-len);

  const safeIdent = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24) || 'unk';

  function sportTo3DigitCodeFlex(code, offsets = [0, 36, 144, 81, 121, 49, 100]) {
    const letters = String(code || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, offsets.length);
    if (!letters) return '000';
    let prod = 1;
    for (let i = 0; i < letters.length; i++) {
      const n = letters.charCodeAt(i) - 96; // a=1..z=26
      prod *= (n + (offsets[i] || 0));
    }
    const val = Math.ceil(Math.sqrt(prod));
    return String(val % 1000).padStart(3, '0');
  }

  function computeSid24({ season, platformCode, leagueId, teamId, sportCode }) {
    const season4 = padNum(season, 4);
    const plat3   = padNum(platformCode, 3);
    const lg12    = padNum(leagueId, 12);
    const tm2     = padNum(teamId, 2);
    const sp3     = sportTo3DigitCodeFlex(sportCode);
    return season4 + plat3 + lg12 + tm2 + sp3; // 24 chars
  }

  function detectCharCode(entry) {
    if (entry?.abbrev) return String(entry.abbrev).toLowerCase(); // 'ffl','fhl','flb',...
    const url = entry?.scoreboardFeedURL || entry?.scoreboardFeedUrl || '';
    const m = /\/games\/([a-z0-9_]{2,})\//i.exec(url);
    if (m) return m[1].toLowerCase();
    const u = entry?.entryURL || entry?.entryUrl || entry?.href || '';
    const m2 = /fantasy\.[^/]+\/([a-z0-9_]+)/i.exec(u);
    if (m2 && m2[1].length <= 6) return m2[1].toLowerCase();
    if (entry?.gameId != null) return `g${String(entry.gameId).replace(/\D+/g, '')}`;
    return 'unk';
  }

  async function ensureCatalogTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ff_sport_code_map (
        char_code text PRIMARY KEY,
        num_code  int UNIQUE NOT NULL
      );
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
      );
    `);
  }

  async function ensureNumCode(charCode) {
    const q1 = await pool.query('SELECT num_code FROM ff_sport_code_map WHERE char_code=$1', [charCode]);
    if (q1.rows[0]) return q1.rows[0].num_code;
    const q2 = await pool.query('SELECT COALESCE(MAX(num_code),0)+1 AS n FROM ff_sport_code_map');
    const num = q2.rows[0].n;
    await pool.query(
      'INSERT INTO ff_sport_code_map (char_code, num_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [charCode, num]
    );
    return num;
  }

  async function ensureSportTable(charCode) {
    const code = safeIdent(charCode);
    const table = `ff_sport_${code}`;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table}(
        sid               text PRIMARY KEY,
        member_id         text NOT NULL,
        season            int  NOT NULL,
        platform          text NOT NULL DEFAULT 'espn',
        league_id         text NOT NULL,
        team_id           text NOT NULL,
        league_name       text,
        owner_name        text,
        team_abbrev       text,
        team_logo_url     text,
        league_logo_url   text,
        group_size        int,
        group_manager     boolean,
        scoring_type_id   int,
        league_type_id    int,
        league_sub_type_id int,
        format_type_id    int,
        in_season         boolean,
        is_live           boolean,
        current_scoring_period int,
        draft_date        timestamptz,
        fantasy_urls      jsonb,
        last_synced_at    timestamptz NOT NULL DEFAULT now(),
        source_etag       text,
        source_hash       text,
        source_payload    jsonb,
        visibility        text,
        status            text,
        swid              text,
        espn_s2           text
      );
      CREATE INDEX IF NOT EXISTS ${table}_season_idx  ON ${table}(season);
      CREATE INDEX IF NOT EXISTS ${table}_league_idx  ON ${table}(season, league_id);
      CREATE INDEX IF NOT EXISTS ${table}_member_idx  ON ${table}(member_id, season);
    `);
    return table;
  }

  async function refreshSportCatalog({ charCode, season, tableName }) {
    const numCode = await ensureNumCode(charCode);
    const { rows:[s] } = await pool.query(`
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
        SET num_code=$3,
            table_name=$4,
            total_count=$5,
            unique_sid_count=$6,
            unique_member_count=$7,
            last_seen_at=now()
    `, [charCode, season, numCode, tableName, s?.total_count||0, s?.unique_sid_count||0, s?.unique_member_count||0]);
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
        r.sid, r.member_id, r.season, 'espn', String(r.league_id), String(r.team_id),
        r.league_name||null, r.owner_name||null, r.team_abbrev||null, r.team_logo_url||null, r.league_logo_url||null,
        r.group_size ?? null, r.group_manager ?? null, r.scoring_type_id ?? null, r.league_type_id ?? null, r.league_sub_type_id ?? null, r.format_type_id ?? null,
        r.in_season ?? null, r.is_live ?? null, r.current_scoring_period ?? null,
        r.draft_date ? new Date(r.draft_date).toISOString() : null,
        r.fantasy_urls ? JSON.stringify(r.fantasy_urls) : null,
        r.last_synced_at || new Date().toISOString(),
        r.source_etag||null, r.source_hash||null, r.source_payload||null,
        r.visibility||null, r.status||null, r.swid||null, r.espn_s2||null
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
        visibility             = EXCLUDED.visibility,
        status                 = EXCLUDED.status
    `, params);
  }

  function extractRowsFromChuiAll({ chui, minSeason, member_id, swid, s2 }) {
    const prefs = Array.isArray(chui?.preferences) ? chui.preferences : [];
    const out = {}; // { char_code: [rows...] }

    for (const p of prefs) {
      const t = p?.type || {};
      if (!(p?.metaData?.entry) || !(t?.id === 9 || t?.code === 'fantasy')) continue;

      const e = p.metaData.entry;
      const season = Number(e?.seasonId);
      if (!Number.isFinite(season) || season < minSeason) continue;

      const charCode = detectCharCode(e);
      const teamId   = e?.entryId;
      const teamName   = e?.entryMetadata?.teamName || null;
      const teamAbbrev = e?.entryMetadata?.teamAbbrev || null;
      const leagueLogo = e?.logoURL || e?.logoUrl || null;
      const teamLogo   = e?.logoUrl || e?.logoURL || null;

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
          member_id,
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

  // ---------- ROUTES ----------

  // POST /api/platforms/espn/ingest
  // Body: { swid, s2, minSeason?, member_id? }  (member_id optional for ghost — falls back to cookie)
  router.post('/espn/ingest', async (req, res) => {
    try {
      const minSeason = Number(req.body?.minSeason) || new Date().getFullYear();

      const swid = String(req.body?.swid || req.get('x-espn-swid') || req.cookies?.SWID || req.cookies?.ff_espn_swid || '').trim();
      const s2   = String(req.body?.s2   || req.get('x-espn-s2')   || req.cookies?.espn_s2 || req.cookies?.ff_espn_s2 || '').trim();
      if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_espn_creds' });

      // member owner (optional; allow ghosts)
      const member_id = String(req.body?.member_id || req.cookies?.ff_member || '').trim() || null;

      // fetch the Fan API (“chui”) using ESPN cookies
      const fanUrl = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
      const resp = await fetch(fanUrl, {
        headers: {
          'accept': 'application/json',
          'cookie': `SWID=${swid}; espn_s2=${encodeURIComponent(s2)}`
        }
      });
      if (!resp.ok) {
        const text = await resp.text().catch(()=> '');
        return res.status(resp.status).json({ ok:false, error:'espn_fetch_failed', status:resp.status, body:text.slice(0,400) });
      }
      const chui = await resp.json();

      await ensureCatalogTables();

      const grouped = extractRowsFromChuiAll({ chui, minSeason, member_id, swid, s2 });
      const results = {};

      for (const raw of Object.keys(grouped)) {
        const charCode  = safeIdent(raw);
        const tableName = await ensureSportTable(charCode);
        await upsertSportRows(tableName, grouped[raw]);
        await refreshSportCatalog({ charCode, season: minSeason, tableName });
        results[charCode] = grouped[raw].length;
      }

      res.json({ ok:true, swid, member_id, minSeason, wrote: results, sports: Object.keys(results).sort() });
    } catch (e) {
      console.error('[espn/ingest]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // POST /api/platforms/espn/ingest-from-quickhitter
  // Body: { member_id? OR handle?, minSeason?, game? }
  // Resolves SWID from ff_quickhitter.quick_snap and S2 from ff_espn_cred (or headers/cookies/body).
  router.post('/espn/ingest-from-quickhitter', async (req, res) => {
    try {
      const member_id = String(req.cookies?.ff_member || req.body?.member_id || '').trim().toUpperCase();
      const handle    = String(req.body?.handle || '').trim();
      const minSeason = Number(req.body?.minSeason) || new Date().getFullYear();
      const gameFilter = String(req.body?.game || '').trim().toLowerCase(); // optional ('ffl', etc)

      if (!member_id && !handle) {
        return res.status(400).json({ ok:false, error:'missing_member_or_handle' });
      }

      // Look up quick_snap
      let q;
      if (member_id) {
        q = await pool.query(
          `SELECT id, member_id, handle, quick_snap
             FROM ff_quickhitter
            WHERE member_id = $1
            LIMIT 1`,
          [member_id]
        );
      } else {
        q = await pool.query(
          `SELECT id, member_id, handle, quick_snap
             FROM ff_quickhitter
            WHERE LOWER(handle) = LOWER($1)
            LIMIT 1`,
          [handle]
        );
      }
      const row = q.rows[0];
      if (!row || !row.quick_snap) {
        return res.status(404).json({ ok:false, error:'quick_snap_not_found' });
      }
      const swid = String(row.quick_snap).trim();

      // Resolve espn_s2
      let s2 = null;
      if (row.member_id) {
        const cred = await pool.query(
          `SELECT espn_s2
             FROM ff_espn_cred
            WHERE member_id = $1
            ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
            LIMIT 1`,
          [row.member_id]
        );
        if (cred.rows[0]?.espn_s2) s2 = String(cred.rows[0].espn_s2);
      }
      if (!s2) s2 = req.get('x-espn-s2') || req.cookies?.espn_s2 || req.body?.s2 || null;
      if (!s2) return res.status(400).json({ ok:false, error:'missing_espn_s2' });

      // Call ESPN
      const fanUrl = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
      const resp = await fetch(fanUrl, {
        headers: { 'accept':'application/json', 'cookie': `SWID=${swid}; espn_s2=${encodeURIComponent(s2)}` }
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(()=> '');
        return res.status(resp.status).json({ ok:false, error:'espn_fetch_failed', status:resp.status, body: txt.slice(0,400) });
      }
      const chui = await resp.json();

      await ensureCatalogTables();

      const grouped = extractRowsFromChuiAll({
        chui,
        minSeason,
        member_id: row.member_id || member_id || null,
        swid,
        s2
      });

      const results = {};
      for (const code of Object.keys(grouped)) {
        if (gameFilter && code.toLowerCase() !== gameFilter) continue;
        const charCode  = safeIdent(code);
        const tableName = await ensureSportTable(charCode);
        await upsertSportRows(tableName, grouped[code]);
        await refreshSportCatalog({ charCode, season: minSeason, tableName });
        results[charCode] = grouped[code].length;
      }

      res.json({
        ok: true,
        member_id: row.member_id || member_id || null,
        handle: row.handle || null,
        swid,
        minSeason,
        wrote: results,
        sports: Object.keys(results).sort()
      });
    } catch (e) {
      console.error('[espn/ingest-from-quickhitter]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // GET /api/platforms/espn/my-teams?game=ffl&minSeason=2025
  router.get('/espn/my-teams', async (req, res) => {
    try {
      const game = String(req.query.game || 'ffl').toLowerCase();
      if (!/^[a-z0-9_]{2,6}$/.test(game)) return res.status(400).json({ ok:false, error:'bad_game' });

      const minSeason = Number(req.query.minSeason) || new Date().getFullYear();

      const member_id = req.cookies?.ff_member || null;
      const swid = req.get('x-espn-swid') || req.cookies?.ff_espn_swid || req.cookies?.SWID || null;
      const s2   = req.get('x-espn-s2')   || req.cookies?.ff_espn_s2   || req.cookies?.espn_s2 || null;

      const tableName = await ensureSportTable(game);
      if (!member_id && !(swid && s2)) {
        return res.status(401).json({ ok:false, error:'unauthorized' });
      }

      const params = [minSeason, member_id, swid, s2].map(x => x ?? null);

      const { rows } = await pool.query(`
        SELECT DISTINCT ON (season, league_id, team_id)
               season,
               league_id,
               team_id,
               COALESCE(owner_name, team_abbrev)        AS team_name,
               team_abbrev,
               league_name,
               NULLIF(team_logo_url, '')                AS team_logo_url,
               NULLIF(league_logo_url, '')              AS league_logo_url
          FROM ${tableName}
         WHERE season >= $1
           AND (
                ($2 IS NOT NULL AND member_id = $2)
                OR
                ($3 IS NOT NULL AND $4 IS NOT NULL AND swid = $3 AND espn_s2 = $4)
           )
         ORDER BY season DESC, league_id, team_id
      `, params);

      res.json({ ok:true, game, minSeason, teams: rows || [] });
    } catch (e) {
      console.error('[espn/my-teams]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  return router;
};
