// server.js — FF Platform Service (fixed root + FEIN static + stable shims)
require('dotenv').config();

console.log('[R2] using bucket =', process.env.R2_BUCKET);
console.log('[R2] endpoint =', process.env.R2_ENDPOINT);

const express       = require('express');
const morgan        = require('morgan');
const cookieParser  = require('cookie-parser');
const fs = require('fs');

const path          = require('path');
const espnConnectRouter = require('./routes/espnconnect');
const coinsignalRouter = require('./routes/coinsignal');
const zeffyRoutes = require('./routes/zeffy');
const wallet = require('./routes/wallet');
const walletsRoutes = require('./routes/wallets');
const poolsPreview = require('./routes/pools');

// server.js
const playerh2h = require('./routes/playerh2h');
const playerMeta = require('./routes/playerMeta'); // path to the file from the canvas
const userLandingRoutes = require('./routes/userLanding');
const trashtalkUserRoutes = require('./routes/trashtalk-user');

// Routers (only require what you actually have in your repo)
const espnLink          = require('./routes/espn/link');               // <-- new UI route (GET /api/espn/link, POST /api/espn/link/ingest)
const espnAuthRouter    = require('./routes/espnAuth');
const ffPointsRouter    = require('./routes/ffPoints');
const espnRouter        = require('./routes/espn');
const hydrateEspn       = require('./routes/espn/hydrate');
const imagesPresign     = require('./routes/images/presign-r2');       // if used elsewhere
const createImagesRouter= require('./src/routes/images');              // if used elsewhere
const pool              = require('./src/db/pool');
// app.js / index.js
const trashtalkRouter = require('./routes/trashtalk');

// Optional helpers used by Kona passthrough
const { fetchFromEspnWithCandidates } = require('./routes/espn/espnCred');

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://fortifiedfantasy.com';

async function deriveFromEspnRoster({ season, week, leagueId, teamId }) {
  const u = new URL('/api/platforms/espn/roster', PUBLIC_BASE);
  u.searchParams.set('season', String(season));
  u.searchParams.set('week', String(week));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('teamId', String(teamId));

  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ESPN roster fetch ${res.status} ${res.statusText}`);

  const j = await res.json();
  const players = j?.players || j?.roster || [];
  if (!Array.isArray(players)) return null;

  let total = 0;
  for (const p of players) {
    const slot = (p.slot || p.lineupSlot || p.lineup || '').toString().toUpperCase();
    const slotId = Number(p.lineupSlotId);
    const isStarter =
      p.isStarter === true ||
      (slot && !['BN', 'BENCH', 'IR', 'OUT', 'INJURED_RESERVE'].includes(slot)) ||
      (Number.isFinite(slotId) && ![20, 21, 22, 23, 24, 25, 26].includes(slotId));

    const ap = Number(p.appliedPoints ?? p.applied_points ?? p.points ?? p.fp ?? p.actual ?? 0);
    if (isStarter && Number.isFinite(ap)) total += ap;
  }

  return Number(total.toFixed(2));
}

const app = express();
const modelLabRouter = require('./routes/modal-lab');
const widgetRouter = require('./routes/widget');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/modal-lab', modelLabRouter);
app.use('/api/widget', widgetRouter);

// REPLACE your current /ff-mini.js route with this one:
app.get('/ff-mini.js', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'public', 'ff-mini.js');
    const stat = fs.statSync(filePath);

    // Absolute “don’t touch this” headers + correct length
    res.status(200);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=14400, must-revalidate, no-transform');
    res.setHeader('Content-Encoding', 'identity');     // explicitly identity
    res.setHeader('Content-Length', String(stat.size)); // exact byte length
    res.setHeader('Accept-Ranges', 'none');             // avoid range/partial gotchas
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Accept-Encoding');

    // Stream raw bytes (no compression middleware involved)
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.status(500).end());
    stream.pipe(res);
  } catch (e) {
    res.status(404).type('text/plain').send('ff-mini.js not found');
  }
});


// ===== Parsers & logs =====
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/trashtalk', trashtalkRouter);
app.use(userLandingRoutes);
app.use(trashtalkUserRoutes);

// === ESPN Fan API proxy (reads leagues straight from ESPN with SWID + s2) ===
function normalizeSwid(raw){
  try{
    let v = decodeURIComponent(String(raw||'')).trim();
    if (!v) return '';
    v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
    if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
    return v.toUpperCase();
  }catch{ return String(raw||''); }
}

async function fanProxyHandler(req, res){
  try {
    const swid = normalizeSwid(req.params?.id || req.query?.SWID || req.query?.swid || req.cookies?.SWID || '');
    const s2   = req.cookies?.espn_s2 || req.query?.s2 || req.query?.espn_s2 || '';
    if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_swid_or_s2' });

    const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
    const r = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: `SWID=${swid}; espn_s2=${s2}`,
        referer: 'https://www.espn.com/'
      }
    });

    const text = await r.text(); // pass-through
    res.status(r.status)
       .set('Content-Type','application/json; charset=utf-8')
       .set('Cache-Control','no-store')
       .send(text);
  } catch (e) {
    console.error('[espn/fan proxy]', e);
    res.status(502).json({ ok:false, error:'espn_fan_upstream_failed' });
  }
}
app.use('/api', require('./routes/users'));

app.get('/api/platforms/espn/fan/me', fanProxyHandler);
app.get('/api/platforms/espn/fan/:id', fanProxyHandler);
app.use('/api/zeffy', zeffyRoutes);
app.use('/api/zeffy', require('./routes/zeffy_embed_credit'));
app.use('/api/points', require('./routes/points'));
app.use('/api/wallet', wallet);
app.use('/api/playerh2h', playerh2h);
app.use('/api', playerMeta);
// existing identity/me middleware should set req.member_id
app.use('/api/points', require('./routes/points'));
app.use('/api/duels',  require('./routes/duels'));
app.use('/api/h2h',    require('./routes/h2h'));
app.use('/api/withdraws', require('./routes/withdraws'));
app.use('/api/wallets', walletsRoutes(pool));

// ===== CORS (CF fronted) =====
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options('*', (req, res) => res.set(allow).sendStatus(204));
app.use((req, res, next) => { res.set(allow); next(); });
app.use(require('./routes/fp_ingest'));  // /api/fp/*
app.use(require('./routes/scoring'));    // /api/scoring/*
// ===== Health & status =====
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/healthz' });
});
app.get('/api/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/api/healthz' });
});

app.set('pg', pool);

app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok:true, name:'ff-platform-service', ts:new Date().toISOString(), espn:{ hasCookies: !!(swid && s2) } });
});
// --- ESPN Connect static (UI) ---
const ESPN_CONNECT_DIR = path.join(__dirname, 'public', 'espnconnect');
app.use('/espnconnect', express.static(ESPN_CONNECT_DIR, {
  index: 'index.html',
  maxAge: '0'
}));

// --- ESPN Connect API (fan + ingest) ---
app.use('/api/espnconnect', espnConnectRouter);
// expose the Fan endpoint under the platforms namespace too, so FE can use one base:
app.use('/api/platforms/espn', espnConnectRouter);
// mount
// server.js
app.use(require('./routes/challenges'));       // routes inside file already use /api/challenges/*
app.use('/api/minileagues', require('./routes/miniLeagues'));

// --- CSP: allow same-origin scripts and inline styles for the page ---
app.use((req, res, next) => {
  res.set('Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://fortifiedfantasy.com",
      "img-src 'self' data: https://img.fortifiedfantasy.com https://a.espncdn.com https://g.espncdn.com",
      "frame-ancestors 'self'",
      "base-uri 'self'"
    ].join('; ')
  );
  next();
});

// ===== Mount the ESPN Link UI (must be before generic espnRouter/catch-alls) =====
app.use('/api/espn', espnConnectRouter); // serves GET /api/espn/link page + POST /api/espn/link/ingest

// ===== ESPN auth/platform namespace =====
app.use('/api/platforms/espn', espnAuthRouter({ pool, cookieDomain: 'fortifiedfantasy.com' }));
app.use('/api/espnconnect', espnConnectRouter);



  // helpers to introspect ff_pools schema
  async function hasColumn(table, col){
    const r = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`, [table, col]);
    return r.rowCount > 0;
  }
  async function getColumnType(table, col){
    const r = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
    return r.rows[0]?.data_type || null;
  }
app.use('/api/pools', poolsPreview);
  // GET /api/ff/teams?season=2025
  app.get('/teams', async (req,res)=>{
    try{
      const { season } = req.query;
      if(!season) return res.status(400).json({error:'Season is required.'});
    const q = `
      SELECT DISTINCT
        season,
        league_id::text AS league_id,
        team_id::text   AS team_id,
        team_name,
        COALESCE(league_name,'') AS league_name,
        COALESCE(league_size,0)  AS league_size
      FROM ff_sport_ffl
      WHERE season=$1
      ORDER BY league_id, team_id`;
    const r = await pool.query(q, [season]);
    res.json({
      teams: r.rows.map(x=>({
        league_id: x.league_id,
        team_id:   x.team_id,
        team_name: x.team_name,
        league_name: x.league_name,
        league_size: Number(x.league_size) || 0
      }))
    });
    }catch(e){ res.status(500).json({error:e.message}); }
  });

  // POST /api/pools/preview { season, weeks[], teamIds[], leagueIds[], scoring[] }
  app.post('/preview', express.json(), async (req,res)=>{
    try{
      const {season, weeks, teamIds, leagueIds, scoring} = req.body||{};
      if(!season || !Array.isArray(weeks) || !weeks.length || !Array.isArray(teamIds) || !teamIds.length || !Array.isArray(leagueIds) || leagueIds.length !== teamIds.length || !Array.isArray(scoring) || !scoring.length){
        return res.status(400).json({error:'Season, weeks[], scoring[], and matching leagueIds[] and teamIds[] arrays are required.'});
      }
      const pointsCol = (await hasColumn('ff_pools','points')) ? 'points' : (await hasColumn('ff_pools','score')) ? 'score' : (await hasColumn('ff_pools','total_points')) ? 'total_points' : null;
      if(!pointsCol) return res.status(500).json({error:"ff_pools is missing a points column (expected 'points', 'score', or 'total_points')."});

      const q = `
        WITH pairs AS (
          SELECT unnest($2::text[]) AS league_id, unnest($3::int[]) AS team_id
        ), t AS (
          SELECT season, league_id::text AS league_id, team_id, week, scoring, points AS team_points
          FROM ff_team_weekly_points
          WHERE season=$1 AND week = ANY($4) AND scoring = ANY($5)
        )
        SELECT t.season, t.league_id, t.team_id, f.team_name, t.week, t.scoring, t.team_points,
               p."${pointsCol}" AS pool_points
        FROM t
        JOIN pairs s ON s.league_id=t.league_id AND s.team_id=t.team_id
        LEFT JOIN ff_pools p
          ON p.season=t.season AND p.week=t.week AND p.team_id=t.team_id
         AND p.scoring=t.scoring AND p.league_id::text=t.league_id
        LEFT JOIN ff_sport_ffl f
          ON f.season=t.season AND f.team_id=t.team_id AND f.league_id::text=t.league_id
        ORDER BY t.week, t.league_id, t.team_id, t.scoring`;
      const r = await pool.query(q, [season, leagueIds.map(String), teamIds, weeks, scoring.map(s=>String(s).toUpperCase())]);
      res.json({rows:r.rows});
    }catch(e){ res.status(500).json({error:e.message}); }
  });

  // POST /api/pools/update { season, weeks[], teamIds[], leagueIds[], scoring[] }
  app.post('/update', express.json(), async (req,res)=>{
    const client = await pool.connect();
    try{
      const {season, weeks, teamIds, leagueIds, scoring} = req.body||{};
      if(!season || !Array.isArray(weeks) || !weeks.length || !Array.isArray(teamIds) || !teamIds.length || !Array.isArray(leagueIds) || leagueIds.length !== teamIds.length || !Array.isArray(scoring) || !scoring.length){
        return res.status(400).json({error:'Season, weeks[], scoring[], and matching leagueIds[] and teamIds[] arrays are required.'});
      }
      const pointsCol = (await hasColumn('ff_pools','points')) ? 'points' : (await hasColumn('ff_pools','score')) ? 'score' : (await hasColumn('ff_pools','total_points')) ? 'total_points' : null;
      if(!pointsCol) return res.status(500).json({error:"ff_pools is missing a points column (expected 'points', 'score', or 'total_points')."});

      const lidType = await getColumnType('ff_pools', 'league_id');
      const tidType = await getColumnType('ff_pools', 'team_id');
      const lidCast = ['bigint','integer','numeric','smallint','decimal'].includes(lidType) ? `::${lidType}` : '::text';
      const tidCast = ['bigint','integer','numeric','smallint','decimal'].includes(tidType) ? `::${tidType}` : '::text';

      const weeklyLidType = await getColumnType('ff_team_weekly_points', 'league_id');
      const weeklyTidType = await getColumnType('ff_team_weekly_points', 'team_id');
      const weeklyLidCast = ['bigint','integer','numeric','smallint','decimal'].includes(weeklyLidType) ? `::${weeklyLidType}` : '::text';
      const weeklyTidCast = ['bigint','integer','numeric','smallint','decimal'].includes(weeklyTidType) ? `::${weeklyTidType}` : '::text';

      await client.query('BEGIN');
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ff_pools_key ON ff_pools(season, league_id, team_id, week, scoring);`);

      const q1 = `
        WITH pairs AS (
          SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
        ),
        scor(scoring) AS (SELECT unnest($5::text[])),
        t_week AS (
          SELECT season, league_id::text AS league_id, team_id::text AS team_id,
                 week, UPPER(scoring) AS scoring, points::numeric AS points, 1 AS pri
          FROM ff_team_weekly_points
          WHERE season=$1 AND week = ANY($4) AND UPPER(scoring)=ANY($5)
        ),
        t_cache AS (
          SELECT c.season, (c.league_id)::text AS league_id, (c.team_id)::text AS team_id,
                 c.week, UPPER(s.scoring) AS scoring,
                 COALESCE(
                   CASE WHEN UPPER(s.scoring)='PPR'  AND (to_jsonb(c)->>'ppr_points')  ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'ppr_points')::numeric END,
                   CASE WHEN UPPER(s.scoring)='HALF' AND (to_jsonb(c)->>'half_points') ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'half_points')::numeric END,
                   CASE WHEN UPPER(s.scoring)='STD'  AND (to_jsonb(c)->>'std_points')  ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'std_points')::numeric END,
                   CASE WHEN (to_jsonb(c)->>'points') ~ '^-?\\d+(\\.\\d+)?$' THEN (to_jsonb(c)->>'points')::numeric END
                 ) AS points, 2 AS pri
          FROM ff_team_points_cache c
          JOIN scor s ON TRUE
          WHERE c.season=$1 AND c.week = ANY($4)
        ),
        all_src AS (SELECT * FROM t_week UNION ALL SELECT * FROM t_cache),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY season, league_id, team_id, week, scoring ORDER BY pri) AS rn
          FROM all_src
        )
        INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
        SELECT a.season,
               (a.league_id||'')${lidCast},
               (a.team_id||'')${tidCast},
               a.week, a.scoring, a.points, now(), now()
        FROM ranked a
        JOIN pairs p ON p.league_id=a.league_id AND p.team_id=a.team_id
        WHERE a.rn=1
        ON CONFLICT (season, league_id, team_id, week, scoring)
        DO UPDATE SET "${pointsCol}"=EXCLUDED."${pointsCol}", updated_at=now();`;

      await client.query(q1, [
        season,
        leagueIds.map(String),
        teamIds.map(String),
        weeks,
        scoring.map(s => String(s).toUpperCase())
      ]);

      const missing = await client.query(
        `WITH pairs AS (
           SELECT unnest($2::text[]) AS league_id, unnest($3::text[]) AS team_id
         ),
         need AS (
           SELECT p.league_id, p.team_id, w AS week
           FROM pairs p CROSS JOIN unnest($4::int[]) AS w
           EXCEPT
           SELECT league_id::text, team_id::text, week FROM ff_team_weekly_points WHERE season=$1
         )
         SELECT * FROM need`,
        [season, leagueIds.map(String), teamIds.map(String), weeks]
      );

      const skipped = [];
      for (const row of missing.rows) {
        let pts = null;
        try {
          pts = await deriveFromEspnRoster({ season, week: row.week, leagueId: row.league_id, teamId: row.team_id });
        } catch (err) {
          console.warn('ff:pools:update deriveFromEspnRoster failed', {
            season,
            league_id: row.league_id,
            team_id: row.team_id,
            week: row.week,
            error: err?.message || err
          });
          skipped.push({
            league_id: String(row.league_id),
            team_id: String(row.team_id),
            week: row.week,
            error: err?.message || 'deriveFromEspnRoster failed'
          });
          continue;
        }

        if (pts == null) {
          skipped.push({
            league_id: String(row.league_id),
            team_id: String(row.team_id),
            week: row.week,
            error: 'No points returned from deriveFromEspnRoster'
          });
          continue;
        }

        await client.query(
          `INSERT INTO ff_team_weekly_points (season, week, league_id, team_id, scoring, points, created_at, updated_at)
           VALUES ($1,$2,($3||'')${weeklyLidCast},($4||'')${weeklyTidCast},'PPR',$5,now(),now())
           ON CONFLICT (season, week, league_id, team_id, scoring)
           DO UPDATE SET points=EXCLUDED.points, updated_at=now()`,
          [season, row.week, String(row.league_id), String(row.team_id), pts]
        );

        await client.query(
          `INSERT INTO ff_pools (season, league_id, team_id, week, scoring, "${pointsCol}", created_at, updated_at)
           VALUES ($1, ($2||'')${lidCast}, ($3||'')${tidCast}, $4, 'PPR', $5, now(), now())
           ON CONFLICT (season, league_id, team_id, week, scoring)
           DO UPDATE SET "${pointsCol}"=EXCLUDED."${pointsCol}", updated_at=now()`,
          [season, String(row.league_id), String(row.team_id), row.week, pts]
        );
      }

      await client.query('COMMIT');
      res.json({ ok:true, upserted: true, skipped });
    }catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:e.message, stack:e.stack}); }
    finally{ client.release(); }
  });



// ===== Kona passthrough (ESPN reads) with masked-cred headers =====
async function konaHandler(req, res) {
  try {
    const game     = String(req.params.game || 'ffl').toLowerCase();
    const season   = Number(req.params.season);
    const leagueId = String(req.params.leagueId);
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
    for (const [k, v] of Object.entries(req.query)) upstream.searchParams.set(k, String(v));

    const { status, body, used } =
      await fetchFromEspnWithCandidates(upstream.toString(), req, {
        leagueId,
        teamId:   req.query?.teamId   || null,
        memberId: req.query?.memberId || null,
      });

    try {
      if (used) {
        if (used.source)     res.set('X-ESPN-Cred-Source', String(used.source));
        if (used.swidMasked) res.set('X-ESPN-Cred-SWID',   String(used.swidMasked));
        if (used.s2Masked)   res.set('X-ESPN-Cred-S2',     String(used.s2Masked));
      }
    } catch {}

    if (used) console.log('[kona] used', used);

    res.set('Content-Type','application/json; charset=utf-8');
    res.set('Cache-Control','no-store, private');
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials','true');

    if (req.query.debug === '1' && status >= 200 && status < 300) {
      const j = JSON.parse(body || '{}');
      j.__cred = used;
      return res.status(status).json(j);
    }
    return res.status(status).send(body);
  } catch (e) {
    console.error('[espn kona passthrough]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
app.get('/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);
app.get('/api/platforms/espn/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);

// ===== Free agents + ingest + poll/roster/league endpoints your FE expects =====
app.use('/api/platforms/espn', require('./routes/espn/free-agents'));
app.use('/api/platforms/espn', require('./routes/espn/free-agents-with-team'));
app.use('/api/ingest/espn/fan', require('./routes/ingest/espn-fan'));
app.use('/api/fp', require('./routes/fp-apply-week'));

// Helper to accept Router or handler exports
function asMiddleware(mod) {
  if (!mod) return null;
  if (mod.default) return asMiddleware(mod.default);
  if (typeof mod === 'function') return mod;
  if (typeof mod.handle === 'function') return mod;
  if (mod.router && typeof mod.router.handle === 'function') return mod.router;
  if (typeof mod.handler === 'function') return mod.handler;
  return null;
}
// poll
{
  const pollMod = require('./routes/espn/poll');
  const pollMw = asMiddleware(pollMod);
  if (!pollMw) throw new Error('espn/poll export is not a middleware or Router');
  app.use('/api/platforms/espn', pollMw);
}
// roster
{
  const rosterMod = require('./routes/espn/roster');
  const rosterMw = asMiddleware(rosterMod);
  if (!rosterMw) throw new Error('espn/roster export is not a middleware or Router');
  app.use('/api/platforms/espn', rosterMw);
}
// league
{
  const leagueMod = require('./routes/espn/league');
  const leagueMw = asMiddleware(leagueMod);
  if (!leagueMw) throw new Error('espn/league export is not a middleware or Router');
  app.use('/api/platforms/espn', leagueMw);
}



// ===== Avatar/logo fallback =====
const sendLogo = (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
  } catch {
    res
      .status(200)
      .set('Cache-Control', 'public, max-age=600')
      .set('Content-Type', 'image/svg+xml')
      .send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f1422"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui" font-size="10" fill="#9fb2c9">FF</text></svg>');
  }
};
app.get('/api/platforms/espn/image/:id', sendLogo);
app.get('/api/espn/image/:id',           sendLogo); // legacy alias
app.get('/api/image/:id',                sendLogo); // generic alias

// ===== Early routers ===== 
app.use('/api/identity', require('./routes/identity/me'));
app.use('/api/session', require('./routes/session')); // mount early
app.use('/api/identity', require('./routes/identity-status'));
app.use('/api/images', createImagesRouter());
app.use('/api/identity', require('./routes/identity/logout'));
// ===== FF points API =====
app.use('/api/ff', ffPointsRouter({ pool }));
// Accept reactions (no-op for now)
app.post('/api/fein/react', express.json(), (_req, res) => res.status(204).end());

// Legacy bootstrap shim
app.get(['/fein/fein-espn-bootstrap.js'], (_req, res) => {
  res.type('application/javascript').set('Cache-Control','no-store').send(
`/* disabled: unified bootstrap in use */
export {};
(function(){ /* no-op */ })();
`);
});

// ===== ESPN hydrate + routers (canonical + legacy) =====
app.use(hydrateEspn());
app.use('/api/platforms/espn', espnRouter);
app.use('/api/espn-auth',      espnRouter); // alias
app.use('/api/espn',           espnRouter); // legacy short base

// IMPORTANT: remove any legacy top-level redirect that forced the old flow
// app.get('/link', (req, res) => { const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''; res.redirect(302, `/api/espn/link${qs}`); });

// ===== PP & identity/session routes =====
app.use('/api/pp', require('./routes/pp/teams'));
app.use('/api/whoami', require('./routes/whoami'));
app.use('/api/ghosts', require('./routes/ghosts'));
app.use('/api/signin', require('./routes/identity/resolve'));
app.use('/api/session', require('./routes/session/loginFromPre'));
app.use('/api/identity', require('./routes/identity/request-code'));
app.use('/api/identity', require('./routes/identity/verify-code'));

const qh = require('./routes/quickhitter');
app.use('/api/identity', require('./src/routes/identity-signup-email'));
app.use('/api/profile',  require('./src/routes/profile'));
app.use('/api/session',  require('./routes/session')); // /check, /exists, /lookup, /avatar, /qh-upsert
app.use('/api/quickhitter', qh);
app.use('/api/identity',   qh); // alias for legacy FE calls

// ===== Compatibility shims the FE expects =====
app.post('/api/verify/start',   (req, res) => res.redirect(307, '/api/identity/request-code'));
app.post('/api/verify/confirm', (req, res) => res.redirect(307, '/api/identity/verify-code'));
app.post('/api/quickhitter/upsert', (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.post('/api/identity/upsert',    (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.get('/api/identity/whoami',     (req, res) => res.redirect(307, '/api/whoami'));

// Lightweight bootstrap (never 401)
app.get('/bootstrap', async (req, res) => {
  try {
    const getSession = require('./routes/session/getSession');
    const sess = await getSession?.(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: !!sess, member_id: sess?.member_id || null });
  } catch {
    res.status(200).json({ ok: true, authenticated: false });
  }
});

// ===== Content Security Policy (allow inline script for /api/espn/link page) =====
app.use((req,res,next)=>{
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +                // <-- needed for link page inline JS
    "connect-src 'self' https://fortifiedfantasy.com; " +
    "img-src 'self' data: https://img.fortifiedfantasy.com https://a.espncdn.com https://g.espncdn.com; " +
    "frame-ancestors 'self'; base-uri 'self'");
  next();
});
// /api/coinsignal/candles?productId=BTC-USD&granularity=3600
// put near top of server.js (once)
app.set('etag', false); // globally disable ETag; or do per-route below

const ALLOWED = new Set([60, 300, 900, 3600, 21600, 86400]); // 1m,5m,15m,1h,6h,1d

// quick in-memory cache to avoid rate-limit thrash
const _cache = new Map(); // key: `${productId}|${granularity}` -> {ts, data}
function getCache(key, ttlMs){ const v = _cache.get(key); return (v && (Date.now()-v.ts < ttlMs)) ? v.data : null; }
function setCache(key, data){ _cache.set(key, { ts: Date.now(), data }); }

// helper: downsample an array of closes by a factor (use the last of each block)
function downsampleCloses(closes, factor){
  if (factor <= 1) return closes;
  const out = [];
  for (let i = factor-1; i < closes.length; i += factor){
    out.push(closes[i]);
  }
  return out.length ? out : [closes.at(-1)];
}
// server.js (add near the other routers, after `app.set('pg', pool)`)

app.use('/api/coinsignal', coinsignalRouter({ pool }));

// ===== FEIN roster JSON alias (TOP-LEVEL, before FEIN static) =====
app.get(['/fein/roster', '/api/roster'], (req, res) => {
  const i = req.originalUrl.indexOf('?');
  const qs = i >= 0 ? req.originalUrl.slice(i) : '';
  res.redirect(307, `/api/platforms/espn/roster${qs}`);
});

// ===== FEIN static hosting + SPA fallback =====
app.get('/', (req, res) => {
  const season = (req.query.season && Number(req.query.season)) || new Date().getUTCFullYear();
  const qs = new URLSearchParams({ season }).toString();
  res.redirect(302, `/fein/?${qs}`);
});
app.get('/fein', (req, res, next) => {
  // Only redirect if season is missing
  if (!('season' in (req.query || {}))) {
    const season = new Date().getUTCFullYear();
    const qs = new URLSearchParams({ season }).toString();
    return res.redirect(302, `/fein/?${qs}`);
  }
  return next(); // let the static / SPA fallback handle it
});


// Serve built FEIN assets
const FEIN_DIR = path.join(__dirname, 'public', 'fein');
app.use('/fein', express.static(FEIN_DIR, {
  index: 'index.html',
  fallthrough: true,
  maxAge: '1h',
  setHeaders(res) {
    const ct = res.getHeader('Content-Type');
    if (ct && String(ct).includes('text/html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// SPA fallback for /fein/* routes
app.get(/^\/fein\/?.*$/, (req, res, next) => {
  if (!req.accepts('html')) return next();
  res.sendFile(path.join(FEIN_DIR, 'index.html'));
});

// Robots
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

// ===== Public static (non-FEIN) =====
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ===== JSON 404 for /api (after all routers!) =====
app.use('/api/*', (req, res) => {
  res.status(200).json({
    ok: false,
    soft: true,
    error: 'not_found',
    path: req.originalUrl || req.url,
  });
});
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// ===== Errors =====
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// ===== Boot =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));

module.exports = { fetchFromEspnWithCandidates };
