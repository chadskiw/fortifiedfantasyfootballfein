// services/audioPermissions.js
//
// Centralized helpers for managing per-party audio contributor policies.
// Hosts can keep uploads restricted to themselves, open the floor to all
// checked-in guests, or approve a specific allowlist of handles.

const pool = require('../src/db/pool');

const DEFAULT_PERMISSIONS = Object.freeze({
  mode: 'host',
  handles: [],
});

const HANDLE_TOKENIZER = /[\s,]+/g;
const VALID_HANDLE = /^[a-z0-9_][a-z0-9._-]{0,31}$/i;

function normalizeHandle(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  const withoutAt = trimmed.replace(/^@+/, '');
  const lowered = withoutAt.toLowerCase();
  if (!VALID_HANDLE.test(withoutAt)) {
    // If it fails the strict matcher, fall back to stripping invalid chars.
    return lowered.replace(/[^a-z0-9._-]/g, '');
  }
  return lowered;
}

function normalizeHandleList(input) {
  if (!input) return [];
  let candidates = [];
  if (Array.isArray(input)) {
    candidates = input;
  } else if (typeof input === 'string') {
    candidates = input.split(HANDLE_TOKENIZER);
  } else {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of candidates) {
    const handle = normalizeHandle(raw);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    normalized.push(handle);
    if (normalized.length >= 64) break; // safety guard
  }
  return normalized;
}

function coerceMode(rawMode) {
  const mode = String(rawMode || '')
    .trim()
    .toLowerCase();
  if (mode === 'handles') return 'handles';
  if (mode === 'all' || mode === 'everyone') return 'all';
  return 'host';
}

function serializePermissions(row) {
  if (!row) return DEFAULT_PERMISSIONS;
  const mode = coerceMode(row.mode);
  const handles = mode === 'handles' ? normalizeHandleList(row.handles || []) : [];
  return {
    mode,
    handles,
    updated_by: row.updated_by || null,
    updated_at: row.updated_at || null,
  };
}

async function fetchPartyAudioPermissions(partyId) {
  if (!partyId) return DEFAULT_PERMISSIONS;
  const { rows } = await pool.query(
    `
      SELECT mode, handles, updated_by, updated_at
        FROM tt_party_audio_contributor
       WHERE party_id = $1
       LIMIT 1
    `,
    [partyId]
  );
  if (!rows.length) {
    return DEFAULT_PERMISSIONS;
  }
  return serializePermissions(rows[0]);
}

async function upsertPartyAudioPermissions(partyId, options = {}) {
  if (!partyId) return DEFAULT_PERMISSIONS;
  const mode = coerceMode(options.mode);
  const handles = mode === 'handles' ? normalizeHandleList(options.handles || []) : [];
  const updatedBy = options.updatedBy || null;
  const { rows } = await pool.query(
    `
      INSERT INTO tt_party_audio_contributor (
        party_id,
        mode,
        handles,
        updated_by,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (party_id)
      DO UPDATE SET
        mode = EXCLUDED.mode,
        handles = EXCLUDED.handles,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING mode, handles, updated_by, updated_at
    `,
    [partyId, mode, handles, updatedBy]
  );
  return serializePermissions(rows[0]);
}

module.exports = {
  DEFAULT_PERMISSIONS,
  normalizeHandle,
  normalizeHandleList,
  fetchPartyAudioPermissions,
  upsertPartyAudioPermissions,
};
