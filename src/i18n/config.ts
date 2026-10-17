import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN/common.json'

export const defaultNS = 'common'

export const resources = {
  'zh-CN': { common: zhCN },
} as const

// 清理历史遗留的语言偏好键（旧版曾支持 zh-TW），确保不残留无效值。
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('transcircle-lang')
  }
} catch {
  // 隐私模式下忽略
}

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    /* 由 React 负责转义：译文只作为 JSX 文本 / 属性渲染（从不进 innerHTML）。
       i18next 再转义一次会把插值里的「/」「&」变成 &#x2F; &amp; 字面量直接显示给用户
       （如「提交于 2026&#x2F;10&#x2F;08」）。 */
    escapeValue: false,
  },
})

export default i18n
