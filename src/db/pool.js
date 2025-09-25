// src/db/pool.js
const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// support both import styles:
//   const { pool } = require('../db/pool')
//   const pool = require('../db/pool')
module.exports = pgPool;       // default export
module.exports.pool = pgPool;  // named export
