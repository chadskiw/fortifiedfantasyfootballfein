const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

module.exports = {
  pool,
  q: (sql, params) => pool.query(sql, params).then(r => r.rows),
};
