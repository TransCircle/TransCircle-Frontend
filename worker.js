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
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      const backend = env.API_BACKEND_URL?.replace(/\/+$/, '');
      if (!backend) {
        // 与后端信封保持一致：SPA 统一按 {error:{code,message}} 解析，纯文本会渲染成无意义响应
        return jsonError('UPSTREAM_UNCONFIGURED', 'API_BACKEND_URL not configured', 'req_skipped');
      }

      // 用户没有 refresh_token cookie 时跳过向后端转发 /auth/refresh，
      // 直接返回 200（accessToken: null），避免产生 400/401 响应。
      if (url.pathname === '/v1/auth/refresh' && request.method === 'POST') {
        const cookies = request.headers.get('cookie') || '';
        const hasRefreshToken = cookies.split(';').some((c) => {
          const pair = c.trim();
          return pair.length > 'refresh_token='.length && pair.startsWith('refresh_token=');
        });
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

      // 剥离客户端可伪造的 X-Forwarded-For（Cloudflare 在边缘设置 CF-Connecting-IP 作为真实来源）。
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.delete('x-forwarded-for');

      try {
        return await fetch(`${backend}${url.pathname}${url.search}`, {
          method: request.method,
          headers: forwardHeaders,
          body: request.body,
        });
      } catch {
        // 上游不可达时 fetch 抛异常，Workers 会返回 1101 内部错误页（HTML）——
        // SPA 的 apiFetch 解析 JSON 会直接崩。统一成 502 信封，前端按 code 显示网络不可用。
        return jsonError('UPSTREAM_UNREACHABLE', 'Backend is unreachable', makeRequestId());
      }
    }

    // SPA fallback is handled by wrangler.jsonc asset config
    // (not_found_handling: single_page_application)
    return env.ASSETS.fetch(request);
  },
};

/** Workers 运行时有原生 crypto.randomUUID，不引入手写随机。 */
function makeRequestId() {
  return 'req_' + crypto.randomUUID();
}

/** @param {string} code @param {string} message @param {string} requestId */
function jsonError(code, message, requestId) {
  return new Response(JSON.stringify({ error: { code, message }, requestId }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}
