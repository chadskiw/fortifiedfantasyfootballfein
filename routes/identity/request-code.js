// routes/identity/request-code.js
// Mount under /api/identity
// Exposes:
//   POST /api/identity/request-code { identifier, handle?, hex? }
//   POST /api/identity/send-code    (alias to request-code)
//   GET  /api/identity/confirm?token=...

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../../src/db/pool');

module.exports = function createRequestCodeRouter(pool) {
  if (!pool) throw new Error('[request-code] pool required');

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  /* ---------------- helpers ---------------- */

  const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
  const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
  const HANDLE_RE = /^[a-zA-Z0-9_.](?:[a-zA-Z0-9_. ]{1,22})[a-zA-Z0-9_.]$/;
  const HEX_RE    = /^#?[0-9a-f]{6}$/i;

  const normalizeHex = (h) => {
    if (!h) return null;
    const v = String(h).trim();
    if (!HEX_RE.test(v.replace('#',''))) return null;
    return v.startsWith('#') ? v.toUpperCase() : ('#' + v.toUpperCase());
  };

  function normalizeIdentifier(raw) {
    const s = String(raw || '').trim();
    if (!s) return { kind:null, value:null };

    if (EMAIL_RE.test(s)) return { kind:'email', value:s.toLowerCase() };

    if (PHONE_RE.test(s)) {
      const digits = s.replace(/[^\d]/g, '');
      const e164 = (digits.length === 10) ? `+1${digits}` :
                   (digits.startsWith('1') && digits.length===11) ? `+${digits}` :
                   `+${digits}`;
      return { kind:'phone', value:e164 };
    }

    if (HANDLE_RE.test(s)) return { kind:'handle', value:s.replace(/\s{2,}/g,' ') };

    return { kind:null, value:null };
  }

  // simple in-proc RL
  const RL = new Map();
  function ratelimit(key, max, winMs) {
    const now = Date.now();
    const rec = RL.get(key);
    if (!rec || now - rec.ts > winMs) { RL.set(key,{ts:now,cnt:1}); return true; }
    if (rec.cnt >= max) return false;
    rec.cnt++; return true;
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ff_identity_requests (
        id                BIGSERIAL PRIMARY KEY,
        identifier_kind   TEXT NOT NULL,
        identifier_value  TEXT NOT NULL,
        token             TEXT UNIQUE,            -- for link verification
        sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at           TIMESTAMPTZ,
        expires_at        TIMESTAMPTZ,
        ip_hash           TEXT
      );
      CREATE INDEX IF NOT EXISTS ff_identity_requests_value_idx ON ff_identity_requests(identifier_value);

      CREATE TABLE IF NOT EXISTS ff_member (
        member_id           TEXT PRIMARY KEY,
        username            TEXT,
        email               TEXT,
        phone_e164          TEXT,
        email_verified_at   TIMESTAMPTZ,
        phone_verified_at   TIMESTAMPTZ,
        color_hex           TEXT,
        login_code          TEXT,
        login_code_expires  TIMESTAMPTZ,
        auth_verified_at    TIMESTAMPTZ,
        first_seen_at       TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at        TIMESTAMPTZ DEFAULT NOW(),
        deleted_at          TIMESTAMPTZ
      );
    `);
  }

  function newMemberId() {
    return crypto.randomBytes(6).toString('base64url')
      .replace(/[^0-9A-Za-z]/g,'').slice(0,8).toUpperCase();
  }

  async function findMemberBy(kind, value) {
    const where =
      kind === 'email'  ? 'LOWER(email)=LOWER($1)' :
      kind === 'phone'  ? 'phone_e164=$1'         :
      kind === 'handle' ? 'LOWER(username)=LOWER($1)' : '1=0';
    const { rows } = await pool.query(`
      SELECT member_id, username, email, phone_e164, color_hex,
             email_verified_at, phone_verified_at
      FROM ff_member
      WHERE ${where} AND deleted_at IS NULL
      LIMIT 1
    `, [value]);
    return rows[0] || null;
  }

  async function findOrCreateMember(kind, value) {
    const ex = await findMemberBy(kind, value);
    if (ex) return ex;

    // try quickhitter glue
    const qhWhere =
      kind === 'email'  ? 'LOWER(email)=LOWER($1)' :
      kind === 'phone'  ? 'phone=$1' :
      kind === 'handle' ? 'LOWER(handle)=LOWER($1)' : '1=0';
    const qh = await pool.query(`
      SELECT member_id, handle, color_hex, phone, email
      FROM ff_quickhitter
      WHERE ${qhWhere}
      LIMIT 1
    `, [value]);
    let member_id = qh.rows[0]?.member_id;

    if (!member_id) {
      // brand new
      for (let i=0;i<4;i++) {
        const mid = newMemberId();
        try {
          await pool.query(
            `INSERT INTO ff_member (member_id, first_seen_at, last_seen_at) VALUES ($1,NOW(),NOW())`,
            [mid]
          );
          member_id = mid;
          break;
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }
    }

    // seed email/phone if we created it
    if (member_id && !ex) {
      if (kind === 'email') {
        await pool.query(`UPDATE ff_member SET email=$1, last_seen_at=NOW() WHERE member_id=$2`, [value, member_id]);
      } else if (kind === 'phone') {
        await pool.query(`UPDATE ff_member SET phone_e164=$1, last_seen_at=NOW() WHERE member_id=$2`, [value, member_id]);
      } else if (kind === 'handle') {
        await pool.query(`UPDATE ff_member SET username=$1, last_seen_at=NOW() WHERE member_id=$2`, [value, member_id]);
      }
      // hydrate from quickhitter (color/handle) if present
      if (qh.rows[0]) {
        const hex = qh.rows[0].color_hex ? (
          qh.rows[0].color_hex.startsWith('#') ? qh.rows[0].color_hex.toUpperCase()
                                               : '#'+qh.rows[0].color_hex.toUpperCase()
        ) : null;
        await pool.query(`
          UPDATE ff_member
          SET username = COALESCE($1, username),
              color_hex= COALESCE($2, color_hex),
              email    = COALESCE($3, email),
              phone_e164=COALESCE($4, phone_e164),
              last_seen_at=NOW()
          WHERE member_id=$5
        `, [qh.rows[0].handle || null, hex, qh.rows[0].email || null, qh.rows[0].phone || null, member_id]);
      }
    }

    const { rows:[m] } = await pool.query(`
      SELECT member_id, username, email, phone_e164, color_hex,
             email_verified_at, phone_verified_at
      FROM ff_member WHERE member_id=$1
    `, [member_id]);
    return m;
  }

  async function sendVerifyLink({ kind, value, url }) {
    // Wire this to your NotificationAPI
    if (process.env.NODE_ENV !== 'production') {
      console.log('[verify-link] to=%s kind=%s url=%s', value, kind, url);
    }
    // Example:
    // await NotificationAPI.send({ to:value, template:'verify_link', data:{ url } });
  }

  /* ---------------- routes ---------------- */

  // POST /api/identity/request-code  { identifier, handle?, hex? }
  router.post('/request-code', async (req, res) => {
    const started = Date.now();
    try {
      await ensureTables();

      const { identifier, handle, hex } = req.body || {};
      const { kind, value } = normalizeIdentifier(identifier);

      if (!value) {
        return res.status(422).json({ ok:false, error:'invalid_identifier' });
      }

      // RL (ip+value)
      const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
      const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
      if (!ratelimit(`${ipHash}:${value}`, 6, 60_000)) {
        return res.status(429).json({ ok:false, error:'rate_limited' });
      }

      // Upsert a member record (or hydrate from quickhitter)
      const member = await findOrCreateMember(kind, value);
      if (!member?.member_id) throw new Error('member_creation_failed');

      // Optionally set username / color_hex if supplied and valid
      const nextUsername = (handle && HANDLE_RE.test(handle)) ? handle.replace(/\s{2,}/g,' ') : null;
      const nextHex      = normalizeHex(hex);
      if (nextUsername || nextHex) {
        await pool.query(
          `UPDATE ff_member
             SET username  = COALESCE($1, username),
                 color_hex = COALESCE($2, color_hex),
                 last_seen_at = NOW()
           WHERE member_id = $3`,
          [nextUsername, nextHex, member.member_id]
        );
      }

      // Create a token (link based)
      const token = crypto.randomBytes(16).toString('base64url');
      const ttlMs = 10 * 60 * 1000; // 10 minutes
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();

      await pool.query(`
        INSERT INTO ff_identity_requests(identifier_kind, identifier_value, token, sent_at, expires_at, ip_hash)
        VALUES ($1,$2,$3,NOW(),$4,$5)
        ON CONFLICT (token) DO UPDATE
          SET sent_at=NOW(), expires_at=$4, ip_hash=$5
      `, [kind, value, token, expiresAt, ipHash]);

      // Build confirm URL using forwarded proto/host
      const proto = req.headers['x-forwarded-proto'] || (process.env.NODE_ENV==='production' ? 'https' : 'http');
      const host  = req.headers['x-forwarded-host']  || req.headers.host || 'fortifiedfantasy.com';
      const confirmUrl = `${proto}://${host}/api/identity/confirm?token=${encodeURIComponent(token)}`;

      // Send link
      await sendVerifyLink({ kind, value, url: confirmUrl });

      // Cookie member
      res.cookie('ff_member', member.member_id, {
        httpOnly: true, sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 365*24*60*60*1000,
      });

      // Tell client where to go
      const u = new URL('/signup', `${proto}://${host}`);
      if (kind === 'email')  u.searchParams.set('email', value);
      if (kind === 'phone')  u.searchParams.set('phone', value);
      if (kind === 'handle') u.searchParams.set('handle', value);

      return res.json({
        ok: true,
        method: 'link',
        token,
        signup_url: u.pathname + u.search,
        ms: Date.now() - started
      });
    } catch (e) {
      console.error('[request-code]', e);
      return res.status(500).json({ ok:false, error:'internal_error' });
    }
  });

  // Alias to support /send-code
  router.post('/send-code', (req, res, next) => { req.url = '/request-code'; next(); });

  // GET /api/identity/confirm?token=...
  router.get('/confirm', async (req, res) => {
    try {
      const token = String(req.query.token || '').trim();
      if (!token) return res.status(400).json({ ok:false, error:'missing_token' });

      const { rows:[reqRow] } = await pool.query(
        `SELECT id, identifier_kind, identifier_value, used_at, expires_at
         FROM ff_identity_requests
         WHERE token=$1`,
        [token]
      );
      if (!reqRow) return res.status(404).json({ ok:false, error:'token_not_found' });
      if (reqRow.used_at) return res.status(409).json({ ok:false, error:'already_used' });
      if (reqRow.expires_at && new Date(reqRow.expires_at) < new Date()) {
        return res.status(410).json({ ok:false, error:'expired' });
      }

      // Promote verification onto member
      const { identifier_kind: kind, identifier_value: value } = reqRow;
      const member = await findOrCreateMember(kind, value);
      if (!member?.member_id) throw new Error('member_not_found');

      if (kind === 'email') {
        await pool.query(
          `UPDATE ff_member SET email=$1, email_verified_at=NOW(), last_seen_at=NOW() WHERE member_id=$2`,
          [value, member.member_id]
        );
      } else if (kind === 'phone') {
        await pool.query(
          `UPDATE ff_member SET phone_e164=$1, phone_verified_at=NOW(), last_seen_at=NOW() WHERE member_id=$2`,
          [value, member.member_id]
        );
      } else if (kind === 'handle') {
        await pool.query(
          `UPDATE ff_member SET username=$1, last_seen_at=NOW() WHERE member_id=$2`,
          [value, member.member_id]
        );
      }

      // mark request used
      await pool.query(`UPDATE ff_identity_requests SET used_at=NOW() WHERE id=$1`, [reqRow.id]);

      // set cookie and bounce to details/fein as you prefer
      const secure = process.env.NODE_ENV === 'production';
      res.cookie('ff_member', member.member_id, {
        httpOnly: true, sameSite: 'Lax', secure,
        maxAge: 365*24*60*60*1000
      });

      return res.json({ ok:true, member_id: member.member_id, verified: kind });
    } catch (e) {
      console.error('[confirm]', e);
      return res.status(500).json({ ok:false, error:'internal_error' });
    }
  });

  return router;
};
