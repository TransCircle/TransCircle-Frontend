import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN/common.json'
import zhTW from './locales/zh-TW/common.json'

export const defaultNS = 'common'

export const resources = {
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
} as const

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
