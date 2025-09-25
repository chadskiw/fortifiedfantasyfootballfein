// src/routes/identity/resolve.js
const express = require('express');
const pool = require('../../db/pool');
const router = express.Router();

/* ---------- helpers ---------- */

function classifyIdentifier(raw) {
  const v = String(raw || '').trim();
  const isEmail  = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  const isPhone  = /^\+?[0-9][0-9\s\-().]{5,}$/.test(v);
  const isHandle = /^[a-zA-Z0-9_.]{3,24}$/.test(v);
  const normPhone = (x)=>{ let t=(x||'').replace(/[^\d+]/g,''); if(t && !t.startsWith('+') && t.length===10) t='+1'+t; return t; };
  if (isEmail)  return { kind:'email',  value:v };
  if (isPhone)  return { kind:'phone',  value:normPhone(v) };
  if (isHandle) return { kind:'handle', value:v };
  return { kind:'unknown', value:v };
}

function hasValidHandleHex(row) {
  const h = row?.handle || '';
  const hex = (row?.color_hex || '').replace(/^#/, '');
  return /^[a-zA-Z0-9_.]{3,24}$/.test(h) && /^[0-9a-fA-F]{6}$/.test(hex);
}

function isVerified(row) {
  // Your ff_quickhitter shows boolean-ish columns `email_is_verified`, `phone_is_verified` (t/f)
  return !!(row?.email_is_verified || row?.phone_is_verified);
}

function setMemberCookie(res, memberId) {
  res.cookie('ff_member', memberId, {
    path: '/', sameSite: 'lax', secure: true, httpOnly: false, maxAge: 31536000 * 1000
  });
}

/* Copy a quickhitter row into ff_member (upsert). 
 * Adjust column names to your ff_member schema if different.
 */
async function promoteQhToMember(client, qh) {
  const hex = (qh.color_hex || '').replace(/^#/, '').toLowerCase();
  await client.query(`
    INSERT INTO ff_member (member_id, handle, color_hex, email, phone_e164, email_is_verified, phone_is_verified, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
    ON CONFLICT (member_id) DO UPDATE
       SET handle            = EXCLUDED.handle,
           color_hex         = EXCLUDED.color_hex,
           email             = COALESCE(EXCLUDED.email, ff_member.email),
           phone_e164        = COALESCE(EXCLUDED.phone_e164, ff_member.phone_e164),
           email_is_verified = GREATEST(COALESCE(ff_member.email_is_verified,false), COALESCE(EXCLUDED.email_is_verified,false)),
           phone_is_verified = GREATEST(COALESCE(ff_member.phone_is_verified,false), COALESCE(EXCLUDED.phone_is_verified,false)),
           updated_at        = now()
  `, [
    qh.member_id,
    qh.handle || null,
    hex || null,
    qh.email || null,
    qh.phone || null,                 // your quickhitter column is "phone"; ff_member uses "phone_e164"
    !!qh.email_is_verified,
    !!qh.phone_is_verified,
  ]);
}

/* ---------- main endpoint ---------- */

router.post('/resolve', async (req, res) => {
  try {
    const raw = (req.body?.identifier || '').trim();
    const verifyContact = (req.body?.verifyContact || '').trim();
    const { kind, value } = classifyIdentifier(raw);
    if (kind === 'unknown') return res.status(422).json({ ok:false, error:'bad_identifier' });

    // 1) Try ff_member first
    let m = null;
    if (kind === 'email') {
      const r = await pool.query(`SELECT * FROM ff_member WHERE LOWER(email)=LOWER($1) LIMIT 1`, [value]);
      m = r.rows[0] || null;
    } else if (kind === 'phone') {
      const r = await pool.query(`SELECT * FROM ff_member WHERE phone_e164=$1 LIMIT 1`, [value]);
      m = r.rows[0] || null;
    } else if (kind === 'handle') {
      const r = await pool.query(`SELECT * FROM ff_member WHERE handle=$1 LIMIT 1`, [value]);
      m = r.rows[0] || null;
    }

    if (m) {
      // Found in ff_member → you can route however you already do (descriptor, /fein, etc.)
      setMemberCookie(res, m.member_id);
      return res.json({
        ok: true,
        source: 'member',
        next: 'fein', // or 'descriptor' if you require it; adjust to your flow
        prefill: {
          member_id: m.member_id,
          handle: m.handle || '',
          hex: (m.color_hex || '').startsWith('#') ? m.color_hex : ('#' + (m.color_hex || '77e0ff')),
          email: m.email || null,
          phone: m.phone_e164 || null
        }
      });
    }

    // 2) Not in member → check ff_quickhitter
    let qh = null;
    if (kind === 'email') {
      const r = await pool.query(`SELECT * FROM ff_quickhitter WHERE LOWER(email)=LOWER($1) LIMIT 1`, [value]);
      qh = r.rows[0] || null;
    } else if (kind === 'phone') {
      const r = await pool.query(`SELECT * FROM ff_quickhitter WHERE phone=$1 LIMIT 1`, [value]);
      qh = r.rows[0] || null;
    } else if (kind === 'handle') {
      const r = await pool.query(`SELECT * FROM ff_quickhitter WHERE handle=$1 LIMIT 1`, [value]);
      qh = r.rows[0] || null;
    }

    if (qh) {
      // 2a) If QH is complete (verified contact + valid handle/hex) → copy to ff_member and go
      if (isVerified(qh) && hasValidHandleHex(qh)) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await promoteQhToMember(client, qh);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK'); throw e;
        } finally {
          client.release();
        }
        setMemberCookie(res, qh.member_id);
        return res.json({
          ok: true,
          source: 'quickhitter',
          outcome: 'promoted',
          next: 'fein',
          prefill: {
            member_id: qh.member_id, handle: qh.handle || '',
            hex: (qh.color_hex || '').startsWith('#') ? qh.color_hex : ('#' + (qh.color_hex || '77e0ff')),
            email: qh.email || null, phone: qh.phone || null
          }
        });
      }

      // 2b) If identifier is email/phone → send to signup-details with prefill (and set cookie)
      if (kind === 'email' || kind === 'phone') {
        setMemberCookie(res, qh.member_id);
        return res.json({
          ok: true,
          source: 'quickhitter',
          outcome: 'needs_verification',
          next: 'signup-details',
          prefill: {
            member_id: qh.member_id,
            handle: qh.handle || '',
            hex: (qh.color_hex || '#77e0ff').replace(/^#/, '#'),
            avatarDataUrl: null,
            pending: {
              email: kind==='email' ? value : (qh.email || undefined),
              phone: kind==='phone' ? value : (qh.phone || undefined)
            }
          }
        });
      }

      // 2c) Identifier is handle → we require a contact to match what's on that handle (if any)
      if (kind === 'handle') {
        const hasAnyContact = !!(qh.email || qh.phone);
        if (verifyContact) {
          const v = verifyContact.trim();
          const vEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
          const vPhone = /^\+?[0-9][0-9\s\-().]{5,}$/.test(v);
          const normPhone = (x)=>{ let t=(x||'').replace(/[^\d+]/g,''); if(t && !t.startsWith('+') && t.length===10) t='+1'+t; return t; };
          const phoneNorm = vPhone ? normPhone(v) : '';
          const emailOk = !!(vEmail && qh.email && v.toLowerCase() === qh.email.toLowerCase());
          const phoneOk = !!(vPhone && qh.phone && phoneNorm === qh.phone);

          if (emailOk || phoneOk) {
            setMemberCookie(res, qh.member_id);
            return res.json({
              ok: true,
              source: 'quickhitter',
              outcome: 'handle_verified_by_contact',
              next: 'signup-details',
              prefill: {
                member_id: qh.member_id,
                handle: qh.handle || '',
                hex: (qh.color_hex || '#77e0ff').replace(/^#/, '#'),
                pending: {
                  email: emailOk ? qh.email : undefined,
                  phone: phoneOk ? qh.phone : undefined
                }
              }
            });
          }
          // contact provided but didn't match
          return res.status(403).json({
            ok:false, error:'contact_mismatch',
            message:'Provided contact does not match this handle.'
          });
        }

        // No verifyContact supplied yet → ask client to collect it
        return res.json({
          ok: true,
          source: 'quickhitter',
          outcome: 'handle_needs_contact',
          next: 'collect-contact',
          hints: { hasEmail: !!qh.email, hasPhone: !!qh.phone }
        });
      }
    }

    // 3) Nothing found anywhere → new signup
    return res.json({
      ok: true,
      source: 'none',
      outcome: 'new_signup',
      next: 'signup',
      prefill: { firstIdentifier: value, type: kind }
    });

  } catch (e) {
    console.error('identity.resolve.error', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
