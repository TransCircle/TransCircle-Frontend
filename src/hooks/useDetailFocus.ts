import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { focusIsOrphaned, focusRowAndWatch, restoreFocus } from '@/components/admin/restoreFocus'

/**
 * 列表 ↔ 详情之间的键盘焦点接力。
 *
 * 这两次切换都会把当前聚焦的元素整个卸载掉：点开某一行时列表被详情（或骨架屏）
 * 替换，点「返回列表」时那个按钮自己消失。焦点随之掉到 body，键盘用户下一次
 * 按 Tab 会从页首重新开始——刚才走到哪儿全白费。
 *
 * 因此：
 *   · 进入详情后把焦点交给「返回列表」按钮（backRef）——它是详情里的第一个控件，
 *     从它开始 Tab 正好顺着往下走；
 *   · 返回列表后把焦点还给当初点开的那一行（按 data-row-id 找）。行已经不在了
 *     （操作后条目移出了当前筛选）时退到 restoreFocus 的兜底。
 *
 * `sessionSeq` 传详情**会话**序号。同一次会话里的重拉（版本冲突后重读、旧操作完成
 * 后刷新）分两种情况，不能一刀切：
 *   · 重拉期间详情被骨架屏整个换掉（AdminUsers / AdminEditRequests 就是这样），
 *     原来聚焦的按钮被卸载，焦点掉到 body——这时必须重新接管，否则焦点永久丢失；
 *   · 详情一直在（Admin 的审核历史是另一个请求，正文早就渲染好了），用户可能
 *     正在备注框里打字——这时绝不能抢。
 * 判据因此是「焦点是不是已经没人认领」，而不是「会话变没变」。
 */
export function useDetailFocus(detailShown: boolean, sessionSeq: RefObject<number>) {
  const backRef = useRef<HTMLButtonElement>(null)
  const focusedSessionRef = useRef(-1)

  useEffect(() => {
    if (!detailShown) return
    const newSession = focusedSessionRef.current !== sessionSeq.current
    focusedSessionRef.current = sessionSeq.current
    // 新会话直接接管；同一会话内只在焦点确实掉了的时候才接管
    if (newSession || focusIsOrphaned()) backRef.current?.focus()
  }, [detailShown, sessionSeq])

  /** 收起详情时调用，传当初点开的那一行的 id。 */
  const focusRowOnReturn = useCallback((rowId: string | null) => {
    if (!rowId) return
    // 列表要等这次提交渲染出来才存在，推迟一帧再找它
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
      /* 用 focusRowAndWatch 而不是直接 focus：写操作成功后通常还跟着一次异步的
         列表刷新，这一行很可能因为条目移出当前筛选而被删掉，焦点又掉回 body。 */
      if (row) focusRowAndWatch(row)
      else restoreFocus(null)
    })
  }, [])

  return { backRef, focusRowOnReturn }
}
