// _lib/util.js
export const text = (s) => new TextEncoder().encode(s);
export async function sha256Hex(s){
  const h = await crypto.subtle.digest('SHA-256', text(String(s)));
  return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function readCookies(hdr=''){
  const out={}; (hdr||'').split(/;\s*/).forEach(p=>{ if(!p) return; const i=p.indexOf('='); const k=i<0?p:p.slice(0,i); const v=i<0?'':decodeURIComponent(p.slice(i+1)); out[k]=v; });
  return out;
}
export function classifyIdentifier(v){
  const s=String(v||'').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return { kind:'email', value:s };
  if (/^\+?[0-9][0-9\s\-().]{5,}$/.test(s))   return { kind:'phone', value:s };
  if (/^[a-zA-Z0-9_.]{3,24}$/.test(s))        return { kind:'handle', value:s };
  return { kind:'unknown', value:s };
}
