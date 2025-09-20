CHECK THIS OUT
// TRUE_LOCATION: config/utils/decode-fein-auth.js
// IN_USE: FALSE
// config/utils/decode-fein-auth.js
'use strict';
const { Client } = require('pg');

const PEPPER = process.env.S2_PEPPER || ''; // MUST match what you used to store
if (!PEPPER) throw new Error('Set S2_PEPPER env var to your original pepper');

function fromB64Url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function unmaskStr(masked, pepper) {
  const enc = fromB64Url(masked);
  const pep = Buffer.from(pepper, 'utf8');
  const out = Buffer.allocUnsafe(enc.length);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ pep[i % pep.length];
  return out.toString('utf8');
}

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  // Pull the *masked string* we stored in swid_cipher
  const { rows } = await client.query(`
    SELECT user_id,
           convert_from(swid_cipher, 'UTF8') AS masked_blob,
           key_version, octet_length(iv) AS iv_len, octet_length(tag) AS tag_len
    FROM fein_auth
    ORDER BY user_id
  `);

  for (const r of rows) {
    if (Number(r.key_version || 0) !== 0) {
      console.log(r.user_id, 'is not scramble mode (key_version=', r.key_version, ')');
      continue;
    }
    const json = unmaskStr(r.masked_blob, PEPPER);
    let obj = {};
    try { obj = JSON.parse(json); } catch {}
    const { swid = '', s2 = '' } = obj;

    console.log('user:', r.user_id);
    console.log('  SWID:', swid);
    console.log('  S2  :', s2.slice(0, 10) + (s2.length > 10 ? '…' : ''));
  }

  await client.end();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
