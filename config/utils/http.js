import fetch from 'node-fetch';

/**
 * Fetch JSON with timeout and good errors.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} init
 */
export async function jget(url, init = {}) {
  const timeoutMs = init.timeoutMs ?? 15000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
