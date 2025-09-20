import express from 'express';
export function healthRouter() {
  const r = express.Router();
  r.get('/health', (_req, res) => res.json({ ok: true, up: true, ts: Date.now() }));
  return r;
}
module.exports = router; 