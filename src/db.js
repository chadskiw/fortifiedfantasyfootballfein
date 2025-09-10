// src/db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function all(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q    = (t, p) => client.query(t, p);
    const oneQ = async (t, p) => { const r = await client.query(t, p); return r.rows[0] || null; };
    const allQ = async (t, p) => { const r = await client.query(t, p); return r.rows; };
    const val  = await fn({ q, one: oneQ, all: allQ });
    await client.query('COMMIT');
    return val;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, one, all, tx };
