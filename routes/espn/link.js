// routes/espn/link.js
const express = require('express');
const router  = express.Router();

/* --------------------- tiny helpers --------------------- */
function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}
function absoluteOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}
function setCredCookies(req, res, swid, s2) {
  const oneYear = 31536000000;
  const opts = { httpOnly:false, sameSite:'Lax', secure:true, maxAge:oneYear, domain:'fortifiedfantasy.com', path:'/' };
  if (swid) res.cookie('SWID',    swid, opts);
  if (s2)   res.cookie('espn_s2', s2,   opts);
}
async function espnFetch(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const url = new URL(`${origin}/api/platforms/espn/${path.replace(/^\/+/, '')}`);
  Object.entries(qs).forEach(([k,v]) => { if (v!==undefined && v!==null) url.searchParams.set(k, String(v)); });
  url.searchParams.set('_t', Date.now());
  const headers = {
    'accept': 'application/json',
    'x-espn-swid': req._link?.swid || req.cookies?.SWID || '',
    'x-espn-s2'  : req._link?.s2   || req.cookies?.espn_s2 || '',
    'user-agent' : 'ff-link-ui/1.0'
  };
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`[${path}] ${r.status} ${r.statusText}`);
  return r.json();
}
function teamDisplayName(t) {
  return t?.teamName || t?.name || [t?.location, t?.nickname].filter(Boolean).join(' ') || t?.abbrev || `Team ${t?.teamId ?? t?.id ?? ''}`;
}

/* ------------------------ HTML UI ------------------------ */
const PAGE_HTML = (params) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Link ESPN → Choose Teams</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;margin:0;background:#0b1020;color:#e9ecf1}
  header{padding:16px 20px;border-bottom:1px solid #1e2744;background:#0f1630}
  h1{font-size:18px;margin:0 0 4px}
  .sub{opacity:.8;font-size:13px}
  main{padding:20px;max-width:980px;margin:0 auto}
  .card{background:#121a38;border:1px solid #21305e;border-radius:14px;padding:16px;margin:16px 0}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .pill{background:#1b254a;border:1px solid #2b3a73;border-radius:999px;padding:8px 10px;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:12px}
  .team{background:#0f1630;border:1px solid #233166;border-radius:12px;padding:10px;display:flex;gap:10px;align-items:center}
  img.logo{width:28px;height:28px;border-radius:6px;background:#0b1020;border:1px solid #233166;object-fit:contain}
  .tname{font-weight:600;font-size:14px;line-height:1.2}
  .muted{opacity:.75;font-size:12px}
  .actions{display:flex;gap:10px;margin-top:16px}
  button{cursor:pointer;border-radius:10px;border:1px solid #3250b0;background:#2c49a7;color:#fff;padding:10px 14px;font-weight:600}
  button.secondary{background:#0f1630;border-color:#2b3a73}
  .badge{font-size:11px;padding:2px 6px;border-radius:8px;border:1px solid #3c5ad1;background:#203079;margin-left:6px}
  .foot{opacity:.7;font-size:12px;margin-top:10px}
  .ok{color:#79ffa4}
  .err{color:#ff8080}
  .spinner{width:14px;height:14px;border:2px solid #6b7fd6;border-top-color:transparent;border-radius:50%;display:inline-block;animation:spin 1s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  a{color:#9cc3ff;text-decoration:none}
  a:hover{opacity:.9;text-decoration:underline}
  label.choice{display:flex;gap:8px;align-items:center}
</style>
</head>
<body>
<header>
  <h1>Connect ESPN · Choose teams to add</h1>
  <div class="sub">Season <b id="season">${params.season}</b> · After saving, you’ll be sent to <code id="to">${params.to}</code></div>
</header>
<main>
  <div class="card" id="status">
    <div id="statline"><span class="spinner"></span> loading your leagues…</div>
    <div class="foot">We use your <code>SWID</code> and <code>espn_s2</code> cookies (saved for this domain) to find your ESPN fantasy leagues.</div>
  </div>

  <div class="card" id="leagues" hidden>
    <div class="row">
      <div class="pill">Found <b id="leagueCount">0</b> leagues</div>
      <label class="choice pill"><input type="checkbox" id="toggleAll"/> select all teams</label>
    </div>
    <div id="leagueList"></div>
    <div class="actions">
      <button id="save">Add selected teams</button>
      <button class="secondary" id="skip">Skip & go to FEIN</button>
    </div>
    <div class="foot">Already-added teams are shown with a ✓ badge.</div>
  </div>
</main>
<script>
const qs    = new URLSearchParams(location.search);
const season= Number(qs.get('season')||${JSON.stringify(params.season)});
const to    = qs.get('to') || ${JSON.stringify(params.to)};
const swid  = qs.get('swid') || qs.get('SWID');
const s2    = qs.get('s2')   || qs.get('espn_s2') || qs.get('ESPN_S2');

document.getElementById('skip').onclick = ()=> location.href = to;

const statusBox = document.getElementById('status');
const statline  = document.getElementById('statline');
const leaguesEl = document.getElementById('leagues');
const leagueList= document.getElementById('leagueList');
const leagueCount= document.getElementById('leagueCount');
const toggleAll = document.getElementById('toggleAll');
const saveBtn   = document.getElementById('save');

function esc(s){return (s??'').replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));}

async function fetchJSON(url, opts){
  const r = await fetch(url, Object.assign({ credentials:'include' }, opts||{}));
  const t = await r.text();
  try { return { ok:r.ok, status:r.status, data: JSON.parse(t) }; }
  catch { return { ok:r.ok, status:r.status, data: t }; }
}

(async function init(){
  // ensure cookies get set on first load
  if (swid || s2) {
    document.cookie = 'SWID='+encodeURIComponent(swid||'')+'; Path=/; Max-Age='+(60*60*24*365)+'; SameSite=Lax; Secure; Domain=.fortifiedfantasy.com';
    document.cookie = 'espn_s2='+encodeURIComponent(s2||'')+'; Path=/; Max-Age='+(60*60*24*365)+'; SameSite=Lax; Secure; Domain=.fortifiedfantasy.com';
  }
  // kick off background ingest (non-blocking)
  fetch('/api/ingest/espn/fan/season?season='+season+'&games=ffl', { method:'POST' });

  const q = new URLSearchParams({ season, _t: Date.now() });
  const res = await fetchJSON('/api/espn/link/data?'+q.toString());
  if (!res.ok) {
    statline.innerHTML = '<span class="err">Failed to load leagues ('+res.status+')</span>';
    return;
  }
  const payload = res.data;
  const leagues = payload?.leagues || [];
  leagueCount.textContent = leagues.length;
  if (!leagues.length) {
    statline.innerHTML = '<span class="err">No leagues found for that account.</span>';
    return;
  }
  statusBox.hidden = true;
  leaguesEl.hidden = false;

  leagueList.innerHTML = '';
  for (const lg of leagues) {
    const box = document.createElement('div');
    box.className = 'card';
    const meta = document.createElement('div');
    meta.className = 'row';
    meta.innerHTML = '<div class="pill">'+esc(lg.gameAbbrev.toUpperCase())+'</div><div class="pill">League '+esc(lg.leagueId)+'</div><div class="pill">'+esc(lg.leagueName||'')+'</div>';
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const t of lg.teams) {
      const id = 't_'+lg.leagueId+'_'+t.teamId;
      const div = document.createElement('label');
      div.className = 'team';
      const input = document.createElement('input');
      input.type='checkbox'; input.value = JSON.stringify({ season, leagueId:String(lg.leagueId), teamId:Number(t.teamId) });
      if (t.alreadyAdded) input.checked = false; // don't auto-check already-added
      div.appendChild(input);
      const img = document.createElement('img'); img.className='logo'; img.src = t.logo || 'https://g.espncdn.com/lm-static/ffl/images/default_logos/1.svg';
      const text = document.createElement('div');
      const tn = document.createElement('div'); tn.className='tname'; tn.textContent = t.teamName;
      const mm = document.createElement('div'); mm.className='muted'; mm.textContent = 'Team '+t.teamId + (t.wins!=null? (' · '+t.wins+'-'+t.losses+(t.ties?('-'+t.ties):'')):'');
      text.appendChild(tn); text.appendChild(mm);
      div.appendChild(img); div.appendChild(text);
      if (t.alreadyAdded) {
        const badge = document.createElement('span'); badge.className='badge'; badge.textContent='✓ added';
        tn.appendChild(badge);
      }
      grid.appendChild(div);
    }
    box.appendChild(meta);
    box.appendChild(grid);
    leagueList.appendChild(box);
  }

  toggleAll.onchange = (e)=>{
    const boxes = leagueList.querySelectorAll('input[type=checkbox]');
    boxes.forEach(b => { if (!b.closest('.team')?.querySelector('.badge')) b.checked = e.target.checked; });
  };

  saveBtn.onclick = async ()=>{
    const picks = Array.from(leagueList.querySelectorAll('input[type=checkbox]:checked'))
      .map(b => { try { return JSON.parse(b.value); } catch { return null; } })
      .filter(Boolean);
    if (!picks.length){ alert('Select at least one team.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const r = await fetchJSON('/api/espn/link/apply', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ season, picks })
    });
    if (!r.ok) {
      alert('Save failed ('+r.status+'): '+(r.data?.error||''));
      saveBtn.disabled = false; saveBtn.textContent = 'Add selected teams';
      return;
    }
    location.href = to;
  };
})();
</script>
</body></html>`;

/* --------------------- main HTML route ------------------- */
router.get('/link', async (req, res) => {
  const season = Number(req.query.season) || new Date().getUTCFullYear();
  const to     = String(req.query.to || `${absoluteOrigin(req)}/fein/?season=${season}`);
  const swid   = normalizeSwid(req.query.swid || req.query.SWID || req.cookies?.SWID || '');
  const s2     = decodePlus(req.query.s2 || req.query.espn_s2 || req.query.ESPN_S2 || req.cookies?.espn_s2 || '');

  // stash on req for subsequent internal fetches
  req._link = { swid, s2 };

  // make cookies available to FE/script too
  setCredCookies(req, res, swid, s2);

  res.set('cache-control', 'no-store');
  res.type('html').send(PAGE_HTML({ season, to }));
});

/* --------- data feed the page uses to list teams ---------- */
router.get('/link/data', async (req, res) => {
  try {
    const pool   = req.app.get('pg');
    const season = Number(req.query.season) || new Date().getUTCFullYear();

    // Which teams are already in ff_sport_ffl?
    const existing = await pool.query(
      `select league_id::text, team_id::int from ff_sport_ffl where season=$1 and platform='espn'`,
      [season]
    );
    const already = new Set(existing.rows.map(r => `${r.league_id}:${r.team_id}`));

    // Poll leagues visible by the ESPN creds
    const poll = await espnFetch(req, 'poll', { season });
    const leagueIds = Array.isArray(poll?.leagues) ? [...new Set(poll.leagues.map(String))]
                     : Array.isArray(poll?.data)    ? [...new Set(poll.data.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))]
                     : Array.isArray(poll)          ? [...new Set(poll.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))]
                     : [];

    const leagues = [];
    for (const leagueId of leagueIds) {
      const league = await espnFetch(req, 'league', { season, leagueId });
      const gameAbbrev = String(league?.gameAbbrev || league?.game || 'ffl').toLowerCase();
      const teams = (league?.teams||[]).map(t => ({
        teamId   : Number(t.teamId ?? t.id),
        teamName : teamDisplayName(t),
        logo     : t.logo || t.teamLogo || null,
        wins     : t?.wins ?? t?.record?.overall?.wins ?? null,
        losses   : t?.losses ?? t?.record?.overall?.losses ?? null,
        ties     : t?.ties ?? t?.record?.overall?.ties ?? null,
        alreadyAdded: already.has(`${leagueId}:${Number(t.teamId ?? t.id)}`)
      }));
      leagues.push({
        leagueId: String(leagueId),
        leagueName: league?.leagueName || league?.name || '',
        gameAbbrev,
        teamCount: teams.length,
        teams
      });
    }

    res.json({ ok:true, season, leaguesCount: leagues.length, leagues });
  } catch (e) {
    console.error('[espn/link/data]', e);
    res.status(500).json({ ok:false, error:'data_failed' });
  }
});

/* ------------- apply: upsert chosen teams only ------------- */
router.post('/link/apply', express.json(), async (req, res) => {
  const pool   = req.app.get('pg');
  const season = Number(req.body?.season) || new Date().getUTCFullYear();
  const picks  = Array.isArray(req.body?.picks) ? req.body.picks : [];

  if (!picks.length) return res.status(400).json({ ok:false, error:'no_picks' });

  try {
    for (const p of picks) {
      const leagueId = String(p.leagueId);
      const teamId   = Number(p.teamId);
      if (!leagueId || !Number.isFinite(teamId)) continue;

      // fetch single team details for display name & points
      const league = await espnFetch(req, 'league', { season, leagueId });
      const t = (league?.teams||[]).find(x => Number(x.teamId ?? x.id) === teamId) || {};
      const teamName = teamDisplayName(t);
      let seasonPts = Number(t?.record?.overall?.pointsFor ?? t?.pointsFor ?? t?.points ?? 0) || 0;

      if (!seasonPts) {
        // Optional: derive from season roster starters
        try {
          const roster = await espnFetch(req, 'roster', { season, leagueId, teamId, scope:'season' });
          const starters = Array.isArray(roster?.starters) ? roster.starters : Array.isArray(roster) ? roster : [];
          seasonPts = starters.reduce((s,x)=> s + (Number(x?.pts ?? x?.fantasyPoints ?? 0) || 0), 0);
        } catch {}
      }

      await pool.query(`
        INSERT INTO ff_sport_ffl
          (season, platform, league_id, team_id, team_name, owner_guid, season_pts, updated_at)
        VALUES ($1, 'espn', $2, $3, $4, NULL, $5, now())
        ON CONFLICT (season, platform, league_id, team_id)
        DO UPDATE SET team_name=EXCLUDED.team_name,
                      season_pts=EXCLUDED.season_pts,
                      updated_at=now()
      `, [season, leagueId, teamId, teamName, seasonPts]);

      // keep FEIN happy right away (light cache)
      await pool.query(`
        INSERT INTO ff_team_points_cache
          (season, league_id, team_id, team_name, scoring, week, week_pts, season_pts, updated_at)
        VALUES ($1,$2,$3,$4,'PPR',1,$5,$5,now())
        ON CONFLICT (season, league_id, team_id, scoring, week)
        DO UPDATE SET team_name=EXCLUDED.team_name,
                      week_pts=EXCLUDED.week_pts,
                      season_pts=EXCLUDED.season_pts,
                      updated_at=now()
      `, [season, leagueId, teamId, teamName, seasonPts]);
    }

    res.json({ ok:true, season, added:picks.length });
  } catch (e) {
    console.error('[espn/link/apply]', e);
    res.status(500).json({ ok:false, error:'apply_failed' });
  }
});

module.exports = router;
