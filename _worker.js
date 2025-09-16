// _worker.js (simplified)
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (/\.(css|js|mjs|png|jpg|svg|ico|webmanifest|json|woff2?)$/i.test(url.pathname)) {
      return env.ASSETS.fetch(request); // serve static file
    }
    if (url.pathname.startsWith('/api/')) {
      // route to your functions/backend...
    }
    // SPA fallback only for HTML navigations
    return env.ASSETS.fetch(new Request(new URL('/', url), request));
  }
};
