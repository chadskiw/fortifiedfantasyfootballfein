// src/db.js
const { Pool } = require('pg');

// Prefer sslmode=require in the URL; this is a belt-and-suspenders fallback.
const isRender = /render\.com/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('PG pool error', err);
});

async function q(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  res.durationMs = Date.now() - start;
  return res;
}

// Simple health probe
async function ping() {
  const r = await q('select 1 as ok');
  return r.rows[0]?.ok === 1;
}

module.exports = { pool, q, ping };
