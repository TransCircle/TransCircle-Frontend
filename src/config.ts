// API base URL — 同源部署，生产与 dev 均使用相对路径
// 生产时 Express serve 前端产物 + API，同域无跨域问题
export const API_BASE: string = '/v1'

/** 登出后跳转目标。生产为 story.transcircle.org，可通过 VITE_LOGOUT_REDIRECT 环境变量覆盖 */
export const LOGOUT_REDIRECT: string =
  import.meta.env.VITE_LOGOUT_REDIRECT ||
  (import.meta.env.PROD ? 'https://story.transcircle.org' : '/')
