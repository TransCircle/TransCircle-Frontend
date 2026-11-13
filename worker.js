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
        return jsonError('UPSTREAM_UNCONFIGURED', 'API_BACKEND_URL not configured');
      }

      // 用户没有 refresh_token cookie 时跳过向后端转发 /auth/refresh，
      // 直接返回 200（accessToken: null），避免产生 400/401 响应。
      //
      // 只在**确认请求体为空**时才短路：后端同样支持经请求体传 refreshToken
      // （api.md §1.11.2 的「原生 / 移动端」通道）。只看 Cookie 会把那条通道上的
      // 请求一并吞成 accessToken:null，且后端日志里什么都看不到。
      if (
        url.pathname === '/v1/auth/refresh' &&
        request.method === 'POST' &&
        !hasRequestBody(request)
      ) {
        const cookies = request.headers.get('cookie') || '';
        const hasRefreshToken = cookies.split(';').some((c) => {
          const pair = c.trim();
          return pair.length > 'refresh_token='.length && pair.startsWith('refresh_token=');
        });
        if (!hasRefreshToken) {
          return new Response(
            JSON.stringify({
              data: { accessToken: null, tokenType: 'Bearer', expiresIn: 0 },
              requestId: makeRequestId(),
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
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
        return jsonError('UPSTREAM_UNREACHABLE', 'Backend is unreachable');
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

/**
 * 请求是否可能带请求体。
 *
 * 只看 Cookie 决定要不要短路，会把经请求体传 refreshToken 的调用方（api.md §1.11.2
 * 的原生通道）一并吞掉。这里保守判断：只要可能带体，就照常转发给后端裁决。
 * @param {Request} request
 */
function hasRequestBody(request) {
  if (request.body) return true;
  const declared = request.headers.get('content-length');
  if (declared && declared !== '0') return true;
  return Boolean(request.headers.get('transfer-encoding'));
}

/** @param {string} code @param {string} message */
function jsonError(code, message) {
  return new Response(
    JSON.stringify({ error: { code, message }, requestId: makeRequestId() }),
    {
      status: 502,
      // 502 不该被中间层缓存；带上 no-store 与后端信封语义一致。
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
