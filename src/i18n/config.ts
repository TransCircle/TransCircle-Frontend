import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN/common.json'
import zhTW from './locales/zh-TW/common.json'

export const defaultNS = 'common'

export const resources = {
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
} as const

// 惰性语言检测：封装在函数内而非模块顶层，避免 SSR 构建时读取 localStorage/navigator 失败
function detectLanguage(): string {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('transcircle-lang') : null
    if (stored) return stored
    if (typeof navigator !== 'undefined' && navigator.language?.startsWith('zh-TW')) return 'zh-TW'
  } catch {
    // 隐私模式/SSR 环境无法访问 localStorage，静默回退
  }
  return 'zh-CN'
}

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: detectLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: {
    // React 的 JSX 默认转义 HTML，escapeValue: true 提供双层防御。
    // 若未来启用 Trans 组件或远程翻译加载，此设置可防止 XSS。
    escapeValue: true,
  },
})

export default i18n
