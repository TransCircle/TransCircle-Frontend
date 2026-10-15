/**
 * Unicode-aware string truncation by character count (not UTF-16 code units)
 */
export function limitByUnicode(str: string, max: number): string {
  // Count by grapheme cluster so combining marks / ZWJ emoji / flags are never
  // split mid-cluster; fall back to code points where Intl.Segmenter is absent.
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const graphemes: string[] = []
    for (const { segment } of segmenter.segment(str)) {
      if (graphemes.length >= max) break
      graphemes.push(segment)
    }
    return graphemes.join('')
  }
  return [...str].slice(0, max).join('')
}

/** 按字符数截断，只有真的截掉了内容才补省略号（避免短串也被误标为「未完」）。 */
export function ellipsize(str: string, max: number): string {
  const cut = limitByUnicode(str, max)
  return cut.length < str.length ? `${cut}…` : cut
}
