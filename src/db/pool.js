// TRUE_LOCATION: src/db/pool.js
// IN_USE: TRUE
const { Pool } = require('pg');

let _pool;

/** Return a shared pg.Pool singleton. */
function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
  _pool.on('error', (err) => {
    console.error('[pg pool error]', err);
  });
  return _pool;
}

module.exports = {
  pool: getPool(),
  getPool,
};
