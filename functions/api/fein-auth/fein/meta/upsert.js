// Cloudflare Pages Function
// Path: /api/fein-auth/fein/meta/upsert
// Methods: OPTIONS, POST
// Requires: a query() helper that talks to your DB (adjust import path if needed)

import { query } from '../../../../lib/db.js'; // adjust if your db helper differs

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // CORS: allow same-origin XHR/fetch and easy testing
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-espn-swid, x-espn-s2',
      ...extra,
    },
  });
}

function parseCookies(h = '') {
  const out = {};
  (h || '').split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}

export const onRequestOptions = async () => json({}, 204);

export const onRequestPost = async ({ request }) => {
  try {
    // --- parse body (JSON only)
    let body = {};
    try {
      if (request.headers.get('content-type')?.includes('application/json')) {
        body = await request.json();
      }
    } catch {}

    const season    = Number(body?.season);
    const platform  = String(body?.platform || '').toLowerCase();
    const league_id = String(body?.league_id || '').trim();
    const team_id   = String(body?.team_id || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return json({ ok: false, error: 'Missing required fields' }, 400);
    }
    if (platform !== 'espn') {
      return json({ ok: false, error: 'platform must be "espn"' }, 400);
    }

    // --- creds from headers, cookies, or body
    const headers = request.headers;
    const cookies = parseCookies(headers.get('cookie') || '');

    const swid =
      (headers.get('x-espn-swid') || body?.swid || cookies.SWID || '').trim();
    const s2 =
      (headers.get('x-espn-s2')   || body?.s2   || cookies.espn_s2 || '').trim();

    if (!swid || !s2) {
      return json({ ok: false, error: 'Missing swid/s2 credentials' }, 400);
    }

    // --- UPSERT into fein_meta
    // Ensure this unique key exists once per DB:
    // ALTER TABLE fein_meta
    //   ADD CONSTRAINT fein_meta_unique UNIQUE (season, platform, league_id, team_id);
    const updated_at = new Date().toISOString();

    const sql = `
      INSERT INTO fein_meta (
        season, platform, league_id, team_id,
        name, handle, league_size, fb_groups,
        swid, espn_s2, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (season, platform, league_id, team_id)
      DO UPDATE SET
        name        = COALESCE(EXCLUDED.name, fein_meta.name),
        handle      = COALESCE(EXCLUDED.handle, fein_meta.handle),
        league_size = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
        fb_groups   = COALESCE(EXCLUDED.fb_groups, fein_meta.fb_groups),
        swid        = COALESCE(EXCLUDED.swid, fein_meta.swid),
        espn_s2     = COALESCE(EXCLUDED.espn_s2, fein_meta.espn_s2),
        updated_at  = EXCLUDED.updated_at
      RETURNING
        id, season, platform, league_id, team_id,
        name, handle, league_size, fb_groups, updated_at
    `;

    const params = [
      season, platform, String(league_id), String(team_id),
      null, null, null, null, // name, handle, league_size, fb_groups (fill later)
      swid, s2, updated_at,
    ];

    const rows = await query(sql, params);
    const row  = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];

    return json({ ok: true, row }, 200);
  } catch (err) {
    return json({ ok: false, error: 'server_error', detail: String(err) }, 500);
  }
};
