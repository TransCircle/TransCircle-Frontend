/**
 * TransCircle Frontend — Cloudflare Workers entry point
 *
 * - API 请求（/v1/*）代理到后端服务器
 * - 静态资源由 wrangler assets 托管
 * - SPA fallback 由 wrangler.jsonc 的 single_page_application 处理
 *
 * API_BACKEND_URL 通过 wrangler.jsonc 的 [env.*.vars] 或 Cloudflare Dashboard 配置。
 * 未配置时抛错而非回退到生产地址，防止开发环境意外写入生产数据。
 */

/** @param {Request} request */
/** @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> }; API_BACKEND_URL?: string }} env */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Proxy API requests to backend server
    if (url.pathname.startsWith('/v1/')) {
      const backend = env.API_BACKEND_URL;
      if (!backend) {
        return new Response('API_BACKEND_URL not configured', { status: 502 });
      }

      // 用户没有 refresh_token cookie 时跳过向后端转发 /auth/refresh，
      // 直接返回 200（accessToken: null），避免产生 400/401 响应。
      if (url.pathname === '/v1/auth/refresh' && request.method === 'POST') {
        const cookies = request.headers.get('cookie') || '';
        const hasRefreshToken = cookies.split(';').some(c =>
          c.trim().startsWith('tcpass_refresh_token='),
        );
        if (!hasRefreshToken) {
          return new Response(
            JSON.stringify({
              data: { accessToken: null, tokenType: 'Bearer', expiresIn: 0 },
              requestId: `req_skipped`,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
      }

      return fetch(`${backend}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    // SPA fallback is handled by wrangler.jsonc asset config
    // (not_found_handling: single_page_application)
    return env.ASSETS.fetch(request);
  },
};
