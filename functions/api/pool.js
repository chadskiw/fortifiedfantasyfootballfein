// functions/api/pool.js
// GET /api/pool?size=12&bg=transparent&fg=%23fff&radius=4&text=FF
// Lightweight placeholder badge (SVG). Default is transparent square.

function svg({ size=12, bg='transparent', fg='#ffffff', radius=0, text='' }) {
  size = Math.max(1, Math.min(1024, Math.floor(size)));
  const r = Math.max(0, Math.min(size/2, Number(radius) || 0));
  const hasText = String(text || '').trim().length > 0;

  const fontSize = Math.max(1, Math.floor(size * 0.55));
  const dy = Math.round(fontSize * 0.35);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${bg}"/>
  ${hasText ? `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
      font-family="system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial" font-weight="700"
      font-size="${fontSize}" fill="${fg}" dy="${dy}">${String(text).slice(0,3)}</text>` : ``}
</svg>`;
}

export const onRequestGet = async ({ request }) => {
  const u = new URL(request.url);
  const size = Number(u.searchParams.get('size') || 12);
  const bg   = u.searchParams.get('bg') || 'transparent';
  const fg   = u.searchParams.get('fg') || '#ffffff';
  const r    = Number(u.searchParams.get('radius') || 0);
  const text = u.searchParams.get('text') || '';

  const body = svg({ size, bg, fg, radius: r, text });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
