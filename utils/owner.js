// utils/owner.js
// Unicode-friendly sanitizer: allow letters/numbers/marks + common name punctuation
const OWNER_SAFE = /[^\p{L}\p{N}\p{M} .,'&()\-]/gu;

function cleanOwner(raw) {
  return String(raw ?? '')
    .replace(OWNER_SAFE, '')   // strip weird stuff safely (no bad ranges)
    .replace(/\s+/g, ' ')
    .trim();
}

// Escape dynamic text before putting it in a RegExp
function reEscape(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { cleanOwner, reEscape };
