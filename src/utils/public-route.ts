/**
 * 公开可匿名浏览的路由判定 —— 静默 SSO 触发条件的同源依据。
 *
 * 产品目标（identity-boundaries.md「故事站统一登录与管理入口」）：公开内容应可匿名浏览；
 * 静默 SSO（Pass OIDC prompt=none）只在「需要认证的路由」上触发，避免匿名访客打开
 * 首页/公开详情时被强制重定向到登录。
 *
 * 公开路由：首页 `/`、公开投稿详情 `/contributions/{id}`、投稿表单 `/submit`
 * （表单允许匿名起草，提交时经 SubmitForm 内联登录，故不强制预登录、也不触发静默 SSO）、
 * 以及登录/认证流程页（`/login`、`/auth/*`——这些由 AuthContext 的 isLoginPage 单独跳过）。
 * 其余路由（`/me/*`、`/settings/*`、`/admin/*`、`/contributions/{id}/edit-request`）需要认证，
 * AuthContext 才会发起静默 SSO，并统一由 RequireAuthLayout 守卫。
 */
export function isPublicPath(pathname: string): boolean {
  // 首页
  if (pathname === '/') return true
  // 公开投稿详情 /contributions/{id}（不含 /edit-request 子路径——那是需要认证的编辑申请页）
  if (/^\/contributions\/[^/]+$/.test(pathname)) return true
  // 投稿表单：允许匿名起草（提交时登录），不强制预登录
  if (pathname === '/submit') return true
  // 登录与认证流程页（登录/注册/回调/错误/step-up/邮箱密码等历史重定向路由）
  if (/^\/(?:auth|login|register)\b/.test(pathname)) return true
  return false
}
