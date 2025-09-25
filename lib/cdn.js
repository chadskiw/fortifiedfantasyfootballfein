// lib/cdn.js
const RAW = process.env.R2_PUBLIC_BASE || process.env.CF_R2_PUBLIC_BASE || '';
const CDN_BASE = RAW.replace(/\/+$/,''); // no trailing slash

function toCdnUrl(key) {
  if (!key) return null;
  const k = String(key).replace(/^\/+/, '');
  return CDN_BASE ? `${CDN_BASE}/${k}` : `/${k}`;
}

function stripCdn(urlOrKey) {
  if (!urlOrKey) return null;
  const s = String(urlOrKey);
  if (!CDN_BASE) return s.replace(/^\/+/, '');
  if (s.startsWith(CDN_BASE)) return s.slice(CDN_BASE.length + (s[CDN_BASE.length] === '/' ? 1 : 0));
  return s.replace(/^\/+/, '');
}

module.exports = { CDN_BASE, toCdnUrl, stripCdn };
