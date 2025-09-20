// TRUE_LOCATION: src/routes/upsert.js
// IN_USE: FALSE
// POST /api/fein-auth/fein/meta/upsert  (verbose temporary logging)
app.post('/api/fein-auth/fein/meta/upsert', async (req, res) => {
  const { upsertFeinMeta } = require('./src/db/feinMeta');

  function readCookiesHeader(header = '') {
    const out = {};
    (header || '').split(/;\s*/).forEach(p => {
      if (!p) return;
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
      out[k] = v;
    });
    return out;
  }
  function normalizeSwid(raw = '') {
    try {
      const v = decodeURIComponent(raw);
      // Ensure braces, e.g., {UUID}
      if (!/^\{[0-9A-F-]{36}\}$/i.test(v) && v) {
        return v.replace(/^\{?/, '{').replace(/\}?$/, '}');
      }
      return v;
    } catch { return raw; }
  }

  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();

    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swidHdr = req.get('x-espn-swid') || req.body?.swid || cookies.SWID || '';
    const s2Hdr   = req.get('x-espn-s2')   || req.body?.s2   || cookies.espn_s2 || '';

    const swid = normalizeSwid((swidHdr || '').trim());
    const s2   = decodeURIComponent((s2Hdr || '').trim());

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok:false, error:'Missing required fields' });
    }
    if (platform !== 'espn') {
      return res.status(400).json({ ok:false, error:'platform must be "espn"' });
    }
    if (!swid || !s2) {
      return res.status(400).json({ ok:false, error:'Missing swid/s2 credentials' });
    }

    const row = await upsertFeinMeta({
      season, platform, league_id, team_id,
      name: null, handle: null, league_size: null, fb_groups: null,
      swid, espn_s2: s2,
    });

    return res.status(200).json({ ok:true, row });
  } catch (err) {
    // TEMP: verbose logging + response for debugging
    console.error('[fein upsert] error:', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      table: err?.table,
      constraint: err?.constraint,
      stack: err?.stack,
    });
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      ...(isProd ? {} : {
        message: err?.message,
        code: err?.code,
        detail: err?.detail,
        stack: err?.stack,
      }),
    });
  }
});
