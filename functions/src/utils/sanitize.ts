/**
 * Per api.md §9: Markdown 内容安全清洗
 * 使用 marked + DOMPurify 实现工业级安全渲染
 */

import { marked } from 'marked'
import { JSDOM } from 'jsdom'
import DOMPurify from 'dompurify'

const dom = new JSDOM('')
const purify = DOMPurify(dom.window as unknown as Parameters<typeof DOMPurify>[0])

const ALLOWED_IMAGE_DOMAINS = [
  'api.transcircle.org',
  'avatars.githubusercontent.com',
  'avatars.',
]

/**
 * Render Markdown to sanitized HTML per api.md §9 rules:
 * - All links get rel="nofollow noopener noreferrer"
 * - Image domains restricted to allowlist
 * - No script, iframe, onerror, onclick, javascript: URLs
 */
export function markdownToHtml(md: string): string {
  // Configure marked with safe options
  const raw = marked.parse(md, { async: false }) as string

  // Post-process links for security
  const processed = raw
    .replace(/<a\s+( href="[^"]*")/gi, '<a$1 rel="nofollow noopener noreferrer"')
    .replace(/<img\s+src="([^"]+)"([^>]*)>/gi, (match: string, src: string) => {
      try {
        const url = new URL(src)
        const allowed = ALLOWED_IMAGE_DOMAINS.some((d) => url.hostname.endsWith(d))
        if (!allowed) {
          return `<a href="${src}" rel="nofollow noopener noreferrer">${src}</a>`
        }
      } catch {
        if (!src.startsWith('/v1/images/')) {
          return `<a href="${src}" rel="nofollow noopener noreferrer">${src}</a>`
        }
      }
      return match
    })

  return purify.sanitize(processed, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'table',
      'thead', 'tbody', 'tr', 'th', 'td', 'del', 'ins', 'sup', 'sub', 'dl', 'dt', 'dd',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'rel', 'target', 'class', 'id'],
    ALLOW_DATA_ATTR: false,
  })
}

/** Plain text → escaped HTML (no Markdown rendering) */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return purify.sanitize(`<p>${escaped.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`, {
    ALLOWED_TAGS: ['p', 'br'],
    ALLOWED_ATTR: [],
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * Lightweight HTML sanitizer for non-Markdown scenarios.
 * Also available as standalone.
 */
export function sanitizeHtml(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'table',
      'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'rel', 'target'],
    ALLOW_DATA_ATTR: false,
  })
}
