// API base URL — 同源部署，生产与 dev 均使用相对路径
// 生产时 Express serve 前端产物 + API，同域无跨域问题
export const API_BASE: string = '/v1'
