import DOMPurify from 'dompurify'

/**
 * 渲染前对 HTML 内容进行白名单清洗，并强制外链安全属性。
 * 符合 AGENTS.md §9.1 内容安全规范：
 * - 禁止 script、iframe、onerror、onclick、javascript: URL
 * - 所有外链加 rel="nofollow noopener noreferrer"
 * - 图片域名可做 allowlist 限制（当前未启用）
 */
export function sanitizeHtml(html: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') !== '_self') {
      node.setAttribute('rel', 'nofollow noopener noreferrer')
      if (!node.getAttribute('target')) {
        node.setAttribute('target', '_blank')
      }
    }
  })

  const result = DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })

  DOMPurify.removeHook('afterSanitizeAttributes')

  return result
}
