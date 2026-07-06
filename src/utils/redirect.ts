/**
 * 校验登录/回调后的重定向目标，防止开放重定向（open redirect）。
 * 仅允许站内相对路径，排除鉴权相关路由，并拦截协议相对（`//`、`/\`）与编码绕过。
 *
 * 由密码登录（Login）与 OAuth 回调（OAuthCallback）共用，保证两处校验强度一致。
 */
export function isValidRedirect(url: string): boolean {
  if (!url.startsWith('/')) return false
  if (url.startsWith('//') || url.startsWith('/\\')) return false
  if (url.length > 200) return false
  // 阻止以 /auth、/login、/register 开头的鉴权路由作为重定向目标
  if (/^\/(auth|login|register)\b/.test(url)) return false
  try {
    // 用 URL 确保不包含非法协议结构
    const parsed = new URL(url, 'http://localhost')
    // 确认解析后的 pathname 与原 url 一致，防止 /%2Fevil.com 等编码绕过
    if (parsed.pathname !== url.split('?')[0]! && decodeURIComponent(parsed.pathname) !== url.split('?')[0]!)
      return false
    return true
  } catch {
    return false
  }
}
