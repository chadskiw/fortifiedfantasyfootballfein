import { readCookies, sha256Hex, classifyIdentifier } from '../_lib/util.js';
import { query, exec } from '../_lib/db.js';

export async function onRequestPost({ request, env }) {
  const cookies = readCookies(request.headers.get('cookie') || '');
  const swid = cookies.SWID || '';
  const s2   = cookies.espn_s2 || '';
  if (!swid || !s2) return json({ ok:false, error:'missing_cookies' }, 401);

  let { identifier } = await request.json().catch(()=>({}));
  const id = classifyIdentifier(identifier);
  if (id.kind === 'unknown') return json({ ok:false, error:'bad_identifier' }, 400);

  const swid_norm = swid.startsWith('{') ? swid.toUpperCase() : `{${swid.replace(/[{}]/g,'').toUpperCase()}}`;
  const s2_hash   = await sha256Hex(s2);

  // Current cred
  const cred = await query(env, `select cred_id, member_id from ff_espn_cred where swid=$1 limit 1`, [swid_norm]);
  if (!cred.length) return json({ ok:false, error:'cred_missing' }, 404);

  // Find member by handle/email/phone
  let member = [];
  if (id.kind === 'handle') {
    member = await query(env, `select member_id from ff_member where username = $1 limit 1`, [id.value]);
  } else if (id.kind === 'email') {
    member = await query(env, `select member_id from ff_member where email = $1 limit 1`, [id.value]);
  } else {
    member = await query(env, `select member_id from ff_member where phone_e164 = $1 limit 1`, [id.value]);
  }

  if (!member.length) {
    return json({ ok:true, step:'signup', identifier: id.value });
  }
  const member_id = member[0].member_id;

  // Multi-account guard: same member already linked to different SWID?
  const linked = await query(env,
    `select swid from ff_espn_cred where member_id = $1 and swid <> $2 limit 1`,
    [member_id, swid_norm]
  );
  if (linked.length) {
    return json({ ok:false, error:'multi_account_not_supported', ghostEligible:true });
  }

  // Attach member to this cred (and refresh s2)
  await exec(env, `
    update ff_espn_cred
       set member_id=$2, espn_s2=$3, s2_hash=$4, last_seen=now()
     where swid=$1
  `, [swid_norm, member_id, s2, s2_hash]);

  await ensureSession(env, request, member_id);
  return json({ ok:true, step:'linked', member_id });
}

function json(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers:{'content-type':'application/json'} });
}
async function ensureSession(env, request, memberId){ /* set your session */ }
