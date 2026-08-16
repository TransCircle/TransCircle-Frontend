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
    // React 的 JSX 默认转义 HTML，escapeValue: true 提供双层防御。
    escapeValue: true,
  },
})

export default i18n
