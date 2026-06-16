import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN/common.json'
import zhTW from './locales/zh-TW/common.json'

export const defaultNS = 'common'

export const resources = {
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
} as const

// Persisted preference > browser detection > zh-CN fallback
const storedLang = typeof localStorage !== 'undefined'
  ? localStorage.getItem('transcircle-lang')
  : null
const detectedLang = storedLang || (typeof navigator !== 'undefined'
  ? (navigator.language?.startsWith('zh-TW') ? 'zh-TW' : 'zh-CN')
  : 'zh-CN')

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: detectedLang,
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
