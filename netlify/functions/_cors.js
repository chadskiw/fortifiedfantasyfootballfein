export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // CORS: allow public reads + preflights
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-fein-key,x-espn-swid,x-espn-s2',
      ...extra
    }
  });
}

export const onOptions = () => json({}, 204);
