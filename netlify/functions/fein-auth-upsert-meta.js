import { q } from '../../db.js';
import { json, onOptions } from './_cors.js';

const WRITE_KEY = (process.env.FEIN_AUTH_KEY || '').trim();
const s = v => (v == null ? '' : String(v));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dedup = (arr) => Array.from(new Set((arr || []).flat().map(x => s(x).trim()).filter(Boolean)));

export const onRequestOptions = onOptions;

export const onRequestPost = async ({ request }) => {
  try {
    if (WRITE_KEY) {
      const k = (request.headers.get('x-fein-key') || '').trim();
      if (!k || k !== WRITE_KEY) return json({ ok:false, error:'Unauthorized (bad x-fein-key)' }, 401);
    }

    const b = await request.json().catch(() => ({}));
    const leagueId   = s(b.leagueId || b.league_id).trim();
    const teamId     = s(b.teamId   || b.team_id).trim();
    const season     = s(b.season || new Date().getFullYear()).trim();
    const leagueSize = n(b.leagueSize ?? b.league_size);

    const name   = s(b.teamName ?? b.name).slice(0,120);
    const handle = s(b.owner    ?? b.handle).slice(0,120);

    const fb_groups = Array.isArray(b.fb_groups) ? b.fb_groups : dedup([b.fbName, b.fbHandle, b.fbGroup]);

    const swid = s(b.swid || b.SWID).trim();
    const s2   = s(b.s2   || b.espn_s2).trim();

    if (!leagueId || !teamId || !season) {
      return json({ ok:false, error:'leagueId, teamId, season required' }, 400);
    }

    const sql = `
      insert into fein_meta (season, league_id, team_id, name, handle, league_size, fb_groups, swid, s2, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      on conflict (season, league_id, team_id)
      do update set
        name        = coalesce(excluded.name, fein_meta.name),
        league_size = coalesce(excluded.league_size, fein_meta.league_size),
        handle      = coalesce(nullif(excluded.handle,''), fein_meta.handle),
        fb_groups   = case
                        when excluded.fb_groups is not null and jsonb_array_length(excluded.fb_groups) > 0
                          then (
                            select jsonb_agg(distinct x)
                            from jsonb_array_elements(coalesce(fein_meta.fb_groups,'[]'::jsonb) || excluded.fb_groups) t(x)
                          )
                        else fein_meta.fb_groups
                      end,
        swid        = coalesce(nullif(excluded.swid,''), fein_meta.swid),
        s2          = coalesce(nullif(excluded.s2  ,''), fein_meta.s2),
        updated_at  = now()
      returning season, league_id, team_id, name, handle, league_size, fb_groups, s2, swid, updated_at
    `;

    const params = [
      season, leagueId, teamId,
      name || null, handle || null,
      leagueSize,
      Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null,
      swid || null, s2 || null
    ];

    const rows = await q(sql, params);
    return json({ ok:true, row: rows[0] || null });
  } catch (e) {
    return json({ ok:false, error:String(e?.message || e) }, 500);
  }
};
