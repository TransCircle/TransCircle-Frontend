export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> } }} env
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Proxy API requests to backend server
    if (url.pathname.startsWith('/v1/')) {
      return fetch(`https://api.transcircle.org${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    // Try static asset first; fall back to index.html for SPA routes
    const response = await env.ASSETS.fetch(request);
    // Cloudflare Assets redirects non-file paths to / with 307 when no
    // matching asset exists; also handle explicit 404s.
    if (!url.pathname.match(/\.\w+$/)) {
      if (response.status >= 300 && response.status < 400) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html', request));
      }
      if (response.status === 404) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html', request));
      }
    }
    return response;
  },
};
