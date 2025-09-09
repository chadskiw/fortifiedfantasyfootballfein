// Shared pg pool for Netlify Node functions
import pg from 'pg';
const { Pool } = pg;

// IMPORTANT: set DATABASE_URL in Netlify env (UI → Site settings → Environment)
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString: DB_URL,
  max: 3,
  ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function q(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
