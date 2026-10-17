/**
 * 按行比较两段文本（修改申请的正文对照、版本对照用）。
 *
 * 先剥掉相同的首尾，再对中间部分做最长公共子序列（LCS）。正文通常几十到几百行，
 * 中间段的 DP 表很小；超过上限时返回 null，调用方退回「当前 / 改为」整段并排。
 */
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** DP 表格子数上限：约 4MB（Uint32Array），足够覆盖千行级别的改动。 */
const MAX_CELLS = 1_000_000

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n')
  const b = after.split('\n')

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const n = midA.length
  const m = midB.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return null

  // lcs[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度（自底向上）
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }))
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ kind: 'del', text: midA[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: midB[j]! })
      j++
    }
  }
  while (i < n) out.push({ kind: 'del', text: midA[i++]! })
  while (j < m) out.push({ kind: 'add', text: midB[j++]! })
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text })
  return out
}

export type DiffChunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; count: number }

/** 只保留改动附近的上下文（默认各 2 行），长段未改动的内容折叠成「未改动 N 行」。 */
export function collapseDiff(lines: DiffLine[], context = 2): DiffChunk[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, idx) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true
  })
  const chunks: DiffChunk[] = []
  let idx = 0
  while (idx < lines.length) {
    if (keep[idx]) {
      const start = idx
      while (idx < lines.length && keep[idx]) idx++
      chunks.push({ kind: 'lines', lines: lines.slice(start, idx) })
    } else {
      const start = idx
      while (idx < lines.length && !keep[idx]) idx++
      chunks.push({ kind: 'gap', count: idx - start })
    }
  }
  return chunks
}
