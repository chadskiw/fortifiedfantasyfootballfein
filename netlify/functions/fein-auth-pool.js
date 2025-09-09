import { q } from './_db.js';
import { json, onOptions } from './_cors.js';

export const onRequestOptions = onOptions;

export const onRequestGet = async ({ request }) => {
  try {
    const u = new URL(request.url);
    const size   = Number(u.searchParams.get('size') || '');
    const season = (u.searchParams.get('season') || '').trim();

    if (!Number.isFinite(size)) return json({ ok:false, error:'size required' }, 400);

    const params = [size];
    let sql = `
      select season, league_id, team_id, name as team_name, handle,
             league_size, fb_groups, updated_at
      from fein_meta
      where league_size = $1
    `;
    if (season) { sql += ` and season = $2`; params.push(season); }
    sql += ` order by season desc, league_id, team_id`;

    const rows = await q(sql, params);
    const shaped = rows.map(r => ({
      league_id: r.league_id,
      season: r.season,
      league_size: r.league_size,
      team_id: r.team_id,
      name: r.team_name,
      handle: r.handle,
      fb_groups: r.fb_groups
    }));

    return json({ ok:true, rows: shaped });
  } catch (e) {
    return json({ ok:false, error:String(e?.message || e) }, 500);
  }
};
