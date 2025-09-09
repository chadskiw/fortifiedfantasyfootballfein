import { q } from '../../db.js';
import { json, onOptions } from './_cors.js';

const WRITE_KEY = (process.env.FEIN_AUTH_KEY || '').trim();

export const onRequestOptions = onOptions;

export const onRequestGet = async ({ request }) => {
  try {
    if (WRITE_KEY) {
      const k = (request.headers.get('x-fein-key') || '').trim();
      if (!k || k !== WRITE_KEY) return json({ ok:false, error:'Unauthorized (bad x-fein-key)' }, 401);
    }

    const u = new URL(request.url);
    const leagueId = (u.searchParams.get('leagueId') || u.searchParams.get('league_id') || '').trim();
    const season   = (u.searchParams.get('season') || u.searchParams.get('year') || '').trim();
    if (!leagueId) return json({ ok:false, error:'leagueId required' }, 400);

    let rows;
    if (season) {
      rows = await q(
        `select swid, s2 from fein_meta
         where league_id = $1 and season = $2 and swid is not null and s2 is not null
         order by updated_at desc limit 1`,
        [leagueId, season]
      );
    } else {
      rows = await q(
        `select swid, s2 from fein_meta
         where league_id = $1 and swid is not null and s2 is not null
         order by updated_at desc limit 1`,
        [leagueId]
      );
    }

    const row = rows?.[0];
    if (!row?.swid || !row?.s2) return json({ ok:false, error:'no stored creds' }, 404);
    return json({ ok:true, swid: row.swid, s2: row.s2 });
  } catch (e) {
    return json({ ok:false, error:String(e?.message || e) }, 500);
  }
};
