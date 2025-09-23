// _lib/db.js
// Provide your own implementation (Neon, pg, Drizzle, etc.)
export async function query(env, sql, params=[]){ /* return rows */ }
export async function exec(env, sql, params=[]){ /* return { rowCount } */ }
