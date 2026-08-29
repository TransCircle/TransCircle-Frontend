import DOMPurify from 'dompurify'

/**
 * 渲染前对 HTML 内容进行白名单清洗，并强制外链安全属性。
 * 符合 AGENTS.md §9.1 内容安全规范：
 * - 禁止 script、iframe、onerror、onclick、javascript: URL
 * - 所有外链加 rel="nofollow noopener noreferrer" 并默认 target=_blank
 * - 例外：页内锚点（#...）与显式 target=_self 的链接保持原样，不新开标签页
 * - 图片域名可做 allowlist 限制（当前未启用）
 */
export function sanitizeHtml(html: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return
    // 页内锚点（#footnote、#heading）与显式 _self 的链接保持原样：
    // 加 target=_blank 会让锚点跳转错误地打开新标签页
    const href = node.getAttribute('href') ?? ''
    if (href.startsWith('#') || node.getAttribute('target') === '_self') return
    node.setAttribute('rel', 'nofollow noopener noreferrer')
    if (!node.getAttribute('target')) {
      node.setAttribute('target', '_blank')
    }
  })

  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    })
  } finally {
    // 异常路径也要摘除全局 hook，避免重复注册累积
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}
