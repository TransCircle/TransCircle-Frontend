// API base URL — 同源部署，生产与 dev 均使用相对路径
// 生产时 Express serve 前端产物 + API，同域无跨域问题
export const API_BASE: string = '/v1'

/** 登出后跳转目标。生产为 story.transcircle.org，可通过 VITE_LOGOUT_REDIRECT 环境变量覆盖 */
export const LOGOUT_REDIRECT: string =
  import.meta.env.VITE_LOGOUT_REDIRECT || (import.meta.env.PROD ? 'https://story.transcircle.org' : '/')

/**
 * TransCircle Pass 账户中心基址。普通用户的安全设置（改密 / 两步验证 / 通行密钥 /
 * 登录设备 / 注销等）一律由 Pass 统一管理，本站仅提供深链跳转。
 * 可通过 VITE_PASS_ACCOUNT_BASE 覆盖。
 */
export const PASS_ACCOUNT_BASE: string = import.meta.env.VITE_PASS_ACCOUNT_BASE || 'https://transcircle.org/account'
