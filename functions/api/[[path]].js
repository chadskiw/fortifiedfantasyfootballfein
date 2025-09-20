CHECK THIS OUT
// TRUE_LOCATION: functions/api/[[path]].js
// IN_USE: FALSE
export async function onRequest({ request }) {
  const inUrl = new URL(request.url);
  const target = new URL(inUrl.pathname.replace(/^\/api/, ''), 'https://<your-render-service>.onrender.com/api');
  // preserve query string
  target.search = inUrl.search;
  const init = {
    method: request.method,
    headers: request.headers,
    body: ['GET','HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer(),
  };
  return fetch(target.toString(), init);
}
