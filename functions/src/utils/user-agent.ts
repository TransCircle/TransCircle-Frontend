/**
 * Minimal User-Agent parser for session device info.
 * Returns browser name, OS name, and device type from the raw UA string.
 */

export interface DeviceInfo {
  browser: string | null
  os: string | null
  type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown'
}

export function parseUserAgent(ua: string): DeviceInfo {
  const lower = ua.toLowerCase()

  // Bot detection
  if (/bot|crawl|spider|scraper|curl|wget|headless/i.test(ua)) {
    return { browser: null, os: null, type: 'bot' }
  }

  // Browser detection
  let browser: string | null = null
  if (lower.includes('edg/') || lower.includes('edge/')) {
    const m = /edge\/(\d+)/i.exec(ua)
    browser = `Edge${m ? ' ' + m[1] : ''}`
  } else if (lower.includes('chrome/') && !lower.includes('chromium')) {
    const m = /chrome\/(\d+)/i.exec(ua)
    browser = `Chrome${m ? ' ' + m[1] : ''}`
  } else if (lower.includes('safari/') && !lower.includes('chrome')) {
    const m = /version\/(\d+)/i.exec(ua)
    browser = `Safari${m ? ' ' + m[1] : ''}`
  } else if (lower.includes('firefox/')) {
    const m = /firefox\/(\d+)/i.exec(ua)
    browser = `Firefox${m ? ' ' + m[1] : ''}`
  } else if (lower.includes('msie') || lower.includes('trident')) {
    browser = 'Internet Explorer'
  } else if (lower.includes('opera')) {
    browser = 'Opera'
  }

  // OS detection
  let os: string | null = null
  if (lower.includes('windows')) {
    const m = /windows nt (\d+\.?\d*)/i.exec(ua)
    const versions: Record<string, string> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.2': 'XP', '5.1': 'XP' }
    os = `Windows${m ? ' ' + (versions[m[1]] || m[1]) : ''}`
  } else if (lower.includes('mac os x') || lower.includes('macintosh')) {
    const m = /mac os x (\d+[._\d]*)/i.exec(ua)
    os = `macOS${m ? ' ' + m[1].replace(/_/g, '.') : ''}`
  } else if (lower.includes('linux') && !lower.includes('android')) {
    os = 'Linux'
  } else if (lower.includes('android')) {
    const m = /android (\d+\.?\d*)/i.exec(ua)
    os = `Android${m ? ' ' + m[1] : ''}`
  } else if (lower.includes('ios') || lower.includes('iphone os') || lower.includes('ipad')) {
    const m = /os (\d+[._\d]*)/i.exec(ua)
    os = `iOS${m ? ' ' + m[1].replace(/_/g, '.') : ''}`
  } else if (lower.includes('crkeyboard')) {
    os = 'ChromeOS'
  }

  // Device type detection
  let type: DeviceInfo['type'] = 'desktop'
  if (lower.includes('ipad') || lower.includes('tablet') || lower.includes('playbook') || lower.includes('silk')) {
    type = 'tablet'
  } else if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('ipod') ||
             lower.includes('android.*mobile') || lower.includes('blackberry') || lower.includes('wpdesktop')) {
    type = 'mobile'
  }

  return { browser, os, type }
}
