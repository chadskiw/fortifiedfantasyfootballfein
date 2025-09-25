// src/routes/debug/db.js
const express = require('express');
const { pool } = require('../../src/db/pool');
const router = express.Router();

router.get('/db-info', async (_req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        current_database()     AS database,
        current_user           AS "user",
        current_schema()       AS schema,
        version()              AS version,
        (SELECT setting FROM pg_settings WHERE name='search_path') AS search_path
    `);
    // show where we're connected (host:db) but avoid leaking creds
    const url = process.env.DATABASE_URL || '';
    const host = url.replace(/^.+@/,'').replace(/[:/].*$/,'');
    res.json({ ok: true, connected_to: host, ...q.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/ff-tables', async (_req, res) => {
  try {
    const tables = await pool.query(`
      SELECT table_schema, table_name
        FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
         AND table_name IN ('ff_league','ff_team')
       ORDER BY table_schema, table_name
    `);

    // row counts (if present)
    const counts = {};
    for (const t of tables.rows) {
      const tn = `"${t.table_schema}"."${t.table_name}"`;
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${tn}`);
      counts[`${t.table_schema}.${t.table_name}`] = c.rows[0].n;
    }

    res.json({ ok: true, tables: tables.rows, counts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
