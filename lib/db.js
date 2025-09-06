// lib/db.js — simple Postgres helper for Render
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // set in Render dashboard
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    client.release();
  }
}
