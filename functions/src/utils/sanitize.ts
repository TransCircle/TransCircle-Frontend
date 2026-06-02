/**
 * Per api.md §9: Markdown 内容安全清洗
 *
 * 当前为轻量级 HTML 净化实现。
 * 生产环境建议使用 DOMPurify（服务端版本 isomorphic-dompurify）。
 */

/** 简易白名单 HTML 清洗 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
}

/** 简易 Markdown → HTML 渲染（仅支持基础语法） */
export function markdownToHtml(md: string): string {
  return sanitizeHtml(
    md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // code block
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // images (allowlist only /v1/images/*)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
        if (url.startsWith('/v1/images/') || url.startsWith('https://api.transcircle.org/v1/images/')) {
          return `<img src="${url}" alt="${alt}" />`
        }
        return `<a href="${url}">${alt}</a>`
      })
      // links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow noopener noreferrer">$1</a>')
      // paragraphs (double newline)
      .replace(/\n\n/g, '</p><p>')
      // line break
      .replace(/\n/g, '<br/>'),
  )
}
