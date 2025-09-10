// Minimal Postgres helper for Render (CommonJS)
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    client.release();
  }
}

module.exports = { query };
