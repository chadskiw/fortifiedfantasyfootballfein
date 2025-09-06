// server/lib/db.js
import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // set in Render
  ssl: { rejectUnauthorized: false }
});

// simple health check
export async function ping() {
  const { rows } = await pool.query('select 1 as ok');
  return rows[0]?.ok === 1;
}
