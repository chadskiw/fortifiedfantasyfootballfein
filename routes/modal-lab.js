// routes/model-lab.js
// ModelLab presets backend for playoffs / projection tuning

const express = require('express');
const router  = express.Router();

let db   = require('../src/db/pool'); // adjust path if needed
let pool = db.pool || db;

if (!pool || typeof pool.query !== 'function') {
  throw new Error('[model-lab] pg pool.query not available — check require path/export');
}

// Parse JSON bodies
router.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Try to get the current member_id from whatever auth you use.
// Tweak this to match your actual auth plumbing.
function getMemberId(req) {
  return (
    req.member?.member_id ||
    req.user?.member_id   ||
    req.auth?.member_id   ||
    req.member_id         || // fallback if you set it directly on req
    null
  );
}

// Which knobs are allowed to be stored/updated
const ALLOWED_KNOBS = new Set([
  'playerTrendWeight',
  'defTrendWeight',
  'homeBonus',
  'awayBonus',
  'afterByeBonus',
  'postBigAdj',
  'postStinkAdj',

  // more complex knobs
  'positionAdjustments', // per-pos mul/add
  'bigDeltaByPos',       // per-pos “big game” thresholds
  'stinkDeltaByPos',     // per-pos “stinker” thresholds
  'contextAdjustments',  // per-pos/home/venue scenario adjustments
]);

// Sanitize incoming knobs: only allow known keys, force numbers where needed
function sanitizeKnobs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_KNOBS.has(key)) continue;

    // positionAdjustments: { QB: {mul,add}, WR: {mul,add}, ... }
    if (key === 'positionAdjustments' && value && typeof value === 'object') {
      const pa = {};
      for (const [pos, adj] of Object.entries(value)) {
        if (!adj || typeof adj !== 'object') continue;
        const mul = Number(adj.mul);
        const add = Number(adj.add);
        pa[pos] = {
          mul: Number.isFinite(mul) ? mul : 1,
          add: Number.isFinite(add) ? add : 0,
        };
      }
      out[key] = pa;
      continue;
    }

    // bigDeltaByPos / stinkDeltaByPos: { QB: 8, RB: 6, ... }
    if ((key === 'bigDeltaByPos' || key === 'stinkDeltaByPos') &&
        value && typeof value === 'object') {
      const m = {};
      for (const [pos, v] of Object.entries(value)) {
        const num = Number(v);
        if (!Number.isFinite(num)) continue;
        m[pos] = num;
      }
      out[key] = m;
      continue;
    }

    // contextAdjustments:
    // {
    //   QB: {
    //     home: { postBig: 0.5, postStink: -0.3, afterBye: 0.7 },
    //     away: { ... }
    //   },
    //   ...
    // }
    if (key === 'contextAdjustments' && value && typeof value === 'object') {
      const ctx = {};
      for (const [pos, homeAwayMap] of Object.entries(value)) {
        if (!homeAwayMap || typeof homeAwayMap !== 'object') continue;
        const normalizedPos = pos.toUpperCase();
        ctx[normalizedPos] = ctx[normalizedPos] || {};
        for (const [homeKey, scenarios] of Object.entries(homeAwayMap)) {
          const normalizedHome = homeKey.toLowerCase() === 'away' ? 'away' : 'home';
          ctx[normalizedPos][normalizedHome] = ctx[normalizedPos][normalizedHome] || {};
          if (!scenarios || typeof scenarios !== 'object') continue;
          for (const [scenarioKey, val] of Object.entries(scenarios)) {
            const normalizedScenario = scenarioKey.toLowerCase();
            const num = Number(val);
            if (!Number.isFinite(num)) continue;
            ctx[normalizedPos][normalizedHome][normalizedScenario] = num;
          }
        }
      }
      out[key] = ctx;
      continue;
    }

    // simple numeric knobs
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    out[key] = num;
  }

  return out;
}

// Normalize whatever comes out of Postgres for knobs → plain JS object
function normalizeKnobBlob(blob) {
  if (blob == null) return {};
  if (typeof blob === 'string') {
    try {
      const parsed = JSON.parse(blob);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(blob)) {
    try {
      const parsed = JSON.parse(blob.toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof blob !== 'object') return {};
  return blob;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/model-lab/settings?context=playoffs
 *
 * Returns the "effective" preset for this member/context:
 *  - member default if it exists
 *  - else global default (member_id IS NULL)
 *  - else first preset for that context (member > global)
 */
router.get('/settings', async (req, res) => {
  const memberId = getMemberId(req); // may be null
  const context  = (req.query.context || 'playoffs').toString();

  try {
    let row = null;

    // 1) member default
    if (memberId) {
      const r1 = await pool.query(
        `
        select
          preset_id,
          member_id,
          context,
          preset_name,
          is_default,
          knobs,
          created_at,
          updated_at
        from ff_model_preset
        where context   = $1
          and member_id = $2
          and is_default = true
        order by created_at desc
        limit 1
        `,
        [context, memberId]
      );
      if (r1.rows.length) row = r1.rows[0];
    }

    // 2) global default
    if (!row) {
      const r2 = await pool.query(
        `
        select
          preset_id,
          member_id,
          context,
          preset_name,
          is_default,
          knobs,
          created_at,
          updated_at
        from ff_model_preset
        where context   = $1
          and member_id is null
          and is_default = true
        order by created_at desc
        limit 1
        `,
        [context]
      );
      if (r2.rows.length) row = r2.rows[0];
    }

    // 3) any preset for this context (prefer member > global)
    if (!row) {
      const r3 = await pool.query(
        `
        select
          preset_id,
          member_id,
          context,
          preset_name,
          is_default,
          knobs,
          created_at,
          updated_at
        from ff_model_preset
        where context = $1
          and (member_id = $2 or member_id is null)
        order by
          (member_id = $2) desc,
          member_id nulls last,
          is_default desc,
          created_at asc
        limit 1
        `,
        [context, memberId]
      );
      if (r3.rows.length) row = r3.rows[0];
    }

    if (!row) {
      return res.status(404).json({ ok: false, error: 'no_preset_found' });
    }

    const preset = {
      preset_id:   row.preset_id,
      member_id:   row.member_id,
      context:     row.context,
      preset_name: row.preset_name,
      is_default:  row.is_default,
      knobs:       normalizeKnobBlob(row.knobs),
      created_at:  row.created_at,
      updated_at:  row.updated_at,
    };

    return res.json({ ok: true, preset });
  } catch (err) {
    console.error('[model-lab] GET /settings error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/model-lab/presets?context=playoffs
 *
 * Lists presets visible to this member for a context:
 *  - user's presets (member_id = current)
 *  - global presets (member_id IS NULL)
 */
router.get('/presets', async (req, res) => {
  const memberId = getMemberId(req);
  const context  = (req.query.context || 'playoffs').toString();

  try {
    const { rows } = await pool.query(
      `
      select
        preset_id,
        member_id,
        context,
        preset_name,
        is_default,
        knobs,
        created_at,
        updated_at
      from ff_model_preset
      where context = $1
        and (member_id = $2 or member_id is null)
      order by
        (member_id = $2) desc,
        member_id nulls last,
        is_default desc,
        created_at asc
      `,
      [context, memberId]
    );

    const presets = rows.map(row => ({
      preset_id:   row.preset_id,
      member_id:   row.member_id, // null = global
      context:     row.context,
      preset_name: row.preset_name,
      is_default:  row.is_default,
      knobs:       normalizeKnobBlob(row.knobs),
      created_at:  row.created_at,
      updated_at:  row.updated_at,
    }));

    return res.json({ ok: true, presets });
  } catch (err) {
    console.error('[model-lab] GET /presets error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/model-lab/presets
 *
 * Create a new preset for the current member.
 *
 * Body:
 * {
 *   "context": "playoffs",
 *   "preset_name": "My Aggro Profile",
 *   "is_default": true,
 *   "knobs": { ... }
 * }
 */
router.post('/presets', async (req, res) => {
  const memberId = getMemberId(req);
  if (!memberId) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }

  const context    = (req.body.context || 'playoffs').toString();
  const presetName = (req.body.preset_name || 'Custom').toString();
  const isDefault  = !!req.body.is_default;
  const knobs      = sanitizeKnobs(req.body.knobs);

  if (!presetName.trim()) {
    return res.status(400).json({ ok: false, error: 'preset_name_required' });
  }

  if (Object.keys(knobs).length === 0) {
    return res.status(400).json({ ok: false, error: 'invalid_knobs' });
  }

  try {
    // If new preset is default, unset existing default for this member/context.
    if (isDefault) {
      await pool.query(
        `
        update ff_model_preset
        set is_default = false
        where member_id = $1
          and context   = $2
          and is_default = true
        `,
        [memberId, context]
      );
    }

    const { rows } = await pool.query(
      `
      insert into ff_model_preset (
        member_id, context, preset_name, is_default, knobs
      )
      values ($1, $2, $3, $4, $5)
      returning
        preset_id, member_id, context, preset_name, is_default, knobs, created_at, updated_at
      `,
      [memberId, context, presetName, isDefault, knobs]
    );

    const created = rows[0];
    created.knobs = normalizeKnobBlob(created.knobs);

    return res.status(201).json({ ok: true, preset: created });
  } catch (err) {
    console.error('[model-lab] POST /presets error', err);

    if (err.code === '23505') {
      // unique violation (likely name/context/member clash)
      return res.status(409).json({ ok: false, error: 'duplicate_name' });
    }

    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * PATCH /api/model-lab/presets/:presetId
 *
 * Update a preset owned by the current member.
 * You can rename, change knobs, and/or mark it as default.
 */
router.patch('/presets/:presetId', async (req, res) => {
  const memberId = getMemberId(req);
  if (!memberId) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }

  const presetId = Number(req.params.presetId);
  if (!Number.isInteger(presetId)) {
    return res.status(400).json({ ok: false, error: 'invalid_preset_id' });
  }

  const newContext = req.body.context ? req.body.context.toString() : null;
  const presetName = req.body.preset_name ? req.body.preset_name.toString() : null;
  const isDefault  = (typeof req.body.is_default === 'boolean') ? req.body.is_default : null;
  const knobsPatch = req.body.knobs ? sanitizeKnobs(req.body.knobs) : null;

  try {
    // Must own this preset
    const existingRes = await pool.query(
      'select * from ff_model_preset where preset_id = $1 and member_id = $2',
      [presetId, memberId]
    );

    if (!existingRes.rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const existing = existingRes.rows[0];
    existing.knobs = normalizeKnobBlob(existing.knobs);
    const context  = newContext || existing.context;

    // If setting this as default, unset other defaults for this member/context
    if (isDefault === true) {
      await pool.query(
        `
        update ff_model_preset
        set is_default = false
        where member_id = $1
          and context   = $2
          and is_default = true
          and preset_id <> $3
        `,
        [memberId, context, presetId]
      );
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (newContext) {
      fields.push(`context = $${idx++}`);
      values.push(context);
    }

    if (presetName) {
      fields.push(`preset_name = $${idx++}`);
      values.push(presetName);
    }

    if (isDefault !== null) {
      fields.push(`is_default = $${idx++}`);
      values.push(isDefault);
    }

    if (knobsPatch && Object.keys(knobsPatch).length) {
      const mergedKnobs = { ...(existing.knobs || {}), ...knobsPatch };
      fields.push(`knobs = $${idx++}`);
      values.push(mergedKnobs);
    }

    if (!fields.length) {
      // nothing to update, just return existing
      return res.json({
        ok: true,
        preset: {
          preset_id:   existing.preset_id,
          member_id:   existing.member_id,
          context:     existing.context,
          preset_name: existing.preset_name,
          is_default:  existing.is_default,
          knobs:       normalizeKnobBlob(existing.knobs),
          created_at:  existing.created_at,
          updated_at:  existing.updated_at,
        },
      });
    }

    values.push(presetId, memberId);

    const sql = `
      update ff_model_preset
      set ${fields.join(', ')}
      where preset_id = $${idx++}
        and member_id = $${idx++}
      returning
        preset_id, member_id, context, preset_name, is_default, knobs, created_at, updated_at
    `;

    const { rows } = await pool.query(sql, values);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const updated = rows[0];
    updated.knobs = normalizeKnobBlob(updated.knobs);

    return res.json({ ok: true, preset: updated });
  } catch (err) {
    console.error('[model-lab] PATCH /presets/:presetId error', err);

    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'duplicate_name' });
    }

    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * DELETE /api/model-lab/presets/:presetId
 *
 * Delete a preset owned by the current member.
 */
router.delete('/presets/:presetId', async (req, res) => {
  const memberId = getMemberId(req);
  if (!memberId) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }

  const presetId = Number(req.params.presetId);
  if (!Number.isInteger(presetId)) {
    return res.status(400).json({ ok: false, error: 'invalid_preset_id' });
  }

  try {
    const { rowCount } = await pool.query(
      'delete from ff_model_preset where preset_id = $1 and member_id = $2',
      [presetId, memberId]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[model-lab] DELETE /presets/:presetId error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
