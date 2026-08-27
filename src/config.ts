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

/**
 * 图片/静态资源基址。头像等资源由后端 /me 返回相对路径，
 * 前端拼接此前缀。可通过 VITE_IMAGE_BASE 覆盖。
 */
export const IMAGE_BASE: string = import.meta.env.VITE_IMAGE_BASE || 'https://api.transcircle.org/pass'

/**
 * Cloudflare Turnstile 人机验证 Site Key（评论/举报写操作）。
 * 未配置（本地 dev）时不渲染验证组件，后端同步跳过校验（见 Backend middleware/turnstile.ts）。
 * 可通过 VITE_TURNSTILE_SITE_KEY 覆盖。
 */
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || ''
