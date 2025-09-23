import { readCookies, sha256Hex } from '../_lib/util.js';
import { query, exec } from '../_lib/db.js';

export async function onRequestGet({ request, env }) {
  const cookies = readCookies(request.headers.get('cookie') || '');
  const swid = cookies.SWID || cookies.swid || '';
  const s2   = cookies.espn_s2 || cookies.ESPN_S2 || '';

  if (!swid || !s2) {
    return json({ ok:false, error:'missing_cookies' }, 401);
  }

  const swid_norm = swid.startsWith('{') ? swid.toUpperCase() : `{${swid.replace(/[{}]/g,'').toUpperCase()}}`;
  const swid_hash = await sha256Hex(swid_norm);
  const s2_hash   = await sha256Hex(s2);

  // 1) upsert ff_espn_cred (insert if missing)
  const existing = await query(env,
    `select cred_id, member_id, espn_s2, s2_hash from ff_espn_cred where swid = $1 limit 1`,
    [swid_norm]
  );

  if (!existing.length) {
    await exec(env, `
      insert into ff_espn_cred (swid, espn_s2, swid_hash, s2_hash, first_seen, last_seen)
      values ($1, $2, $3, $4, now(), now())
    `, [swid_norm, s2, swid_hash, s2_hash]);
    // no member yet → ask client to link
    return json({ ok:true, step:'link_needed' });
  }

  // 2) update s2 if changed + touch last_seen
  const row = existing[0];
  if (row.s2_hash !== s2_hash) {
    await exec(env, `update ff_espn_cred set espn_s2=$2, s2_hash=$3, last_seen=now() where swid=$1`,
      [swid_norm, s2, s2_hash]);
  } else {
    await exec(env, `update ff_espn_cred set last_seen=now() where swid=$1`, [swid_norm]);
  }

  // 3) if linked → log in (issue session)
  if (row.member_id) {
    await ensureSession(env, request, row.member_id); // implement for your session system
    return json({ ok:true, step:'logged_in', member_id: row.member_id });
  }

  // Not linked yet
  return json({ ok:true, step:'link_needed' });
}

function json(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers:{'content-type':'application/json'} });
}

// stub — wire to your session table + cookie
async function ensureSession(env, request, memberId){
  // e.g., create ff_session row and set 'ff_sid' cookie
}
