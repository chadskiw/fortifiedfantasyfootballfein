// lib/otp.js
const crypto = require('crypto');
const { pool } = require('../src/db/pool'); // adjust if your pool export differs

function makeCode() {
  // 6-digit numeric, no leading zero issues
  return ('' + (Math.floor(Math.random() * 900000) + 100000));
}

async function setLoginCode(memberId, ttlMinutes = 10) {
  const code = makeCode();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await pool.query(
    `UPDATE ff_member
       SET login_code = $2,
           login_code_expires = $3
     WHERE member_id = $1`,
    [memberId, code, expiresAt.toISOString()]
  );
  return { code, expiresAt };
}

async function checkAndConsumeCode({ memberId, code }) {
  const { rows } = await pool.query(
    `SELECT login_code, login_code_expires
       FROM ff_member
      WHERE member_id = $1
      LIMIT 1`,
    [memberId]
  );
  const row = rows[0];
  const ok = !!row && row.login_code === code &&
             row.login_code_expires && new Date(row.login_code_expires) > new Date();
  if (!ok) return false;

  await pool.query(
    `UPDATE ff_member
        SET login_code = NULL, login_code_expires = NULL,
            auth_verified_at = NOW()
      WHERE member_id = $1`,
    [memberId]
  );
  return true;
}

module.exports = { setLoginCode, checkAndConsumeCode };
