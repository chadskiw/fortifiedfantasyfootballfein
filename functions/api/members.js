// routes/members.js
const express = require('express');

// --- helpers (copy-paste safe + minimal) ---
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

const norm      = (v='') => String(v).trim();
const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');
const isEmail   = v => EMAIL_RE.test(norm(v));
const isPhone   = v => PHONE_RE.test(norm(v));
const isHandle  = v => HANDLE_RE.test(norm(v));

const toLimit   = (v, def=96) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : def;
};
const cleanOrder = (v) => String(v || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

// Build the router with an injected pg Pool
module.exports = function membersRouterFactory(pool){
  const router = express.Router();

  // --- queries used by endpoints ---
  async function fetchMemberByEmailPhoneOrHandle({ email, phone, handle }) {
    const params = [];
    const conds  = [];
    if (email)  { params.push(email);  conds.push(`LOWER(email)=LOWER($${params.length})`); }
    if (phone)  { params.push(phone);  conds.push(`phone_e164=$${params.length}`); }
    if (handle) { params.push(handle); conds.push(`LOWER(username)=LOWER($${params.length})`); }
    if (!conds.length) return null;

    const r = await pool.query(
      `SELECT member_id, username, email, phone_e164, color_hex
         FROM ff_member
        WHERE ${conds.join(' OR ')}
        ORDER BY member_id ASC
        LIMIT 1`,
      params
    );
    return r.rows[0] || null;
  }

  async function doLookup(identifier) {
    const raw = norm(identifier);
    if (isEmail(raw))  return await fetchMemberByEmailPhoneOrHandle({ email: normEmail(raw) });
    if (isPhone(raw))  return await fetchMemberByEmailPhoneOrHandle({ phone: normPhone(raw) });
    if (isHandle(raw)) return await fetchMemberByEmailPhoneOrHandle({ handle: raw });
    return null;
  }

  // --- handlers ---
  async function listMembersHandler(req, res) {
    try {
      const limit    = toLimit(req.query.limit);
      const orderSql = cleanOrder(req.query.order);
      const rows = (await pool.query(
        `
        SELECT
          member_id, username, color_hex, email, phone_e164,
          image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
          event_count, first_seen_at, last_seen_at
        FROM ff_member
        WHERE deleted_at IS NULL
        ORDER BY last_seen_at ${orderSql}
        LIMIT $1
        `, [limit]
      )).rows;

      res.json({ ok: true, items: rows, limit, order: orderSql.toLowerCase() });
    } catch (e) {
      console.error('[GET /members]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  async function listRecentMembersHandler(req, res) {
    try {
      const limit = toLimit(req.query.limit);
      const rows = (await pool.query(
        `
        SELECT
          member_id, username, color_hex, email, phone_e164,
          image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
          event_count, first_seen_at, last_seen_at
        FROM ff_member
        WHERE deleted_at IS NULL
        ORDER BY last_seen_at DESC
        LIMIT $1
        `, [limit]
      )).rows;

      res.json({ ok: true, items: rows, limit });
    } catch (e) {
      console.error('[GET /members/recent]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  async function membersLookupByIdentifier(req, res) {
    try {
      const identifier = (req.method === 'GET' ? req.query.identifier : req.body?.identifier) || '';
      const member = await doLookup(identifier);
      res.json({ ok: true, member });
    } catch (e) {
      console.error('[members.lookup]', e);
      res.status(500).json({ ok:false, error:'server_error' });
    }
  }

  // --- primary routes ---
  router.get('/members', listMembersHandler);
  router.get('/members/recent', listRecentMembersHandler);

  router.get('/members/lookup', membersLookupByIdentifier);
  router.post('/members/lookup', membersLookupByIdentifier);

  // --- identity aliases (same handlers, no hacks) ---
  router.get('/identity/members', listMembersHandler);
  router.get('/identity/members/recent', listRecentMembersHandler);

  router.get('/identity/member/lookup', membersLookupByIdentifier);
  router.post('/identity/member/lookup', membersLookupByIdentifier);

  return router;
};
