/**
 * body 滚动锁（引用计数）。
 *
 * 抽成独立模块供 Modal 与 StepUpDialog 共用：step-up 有时开在理由/确认弹窗
 * 之上（此时 Modal 已持锁），有时是直接弹出的（发布、解封等无需理由的操作），
 * 后一种情况下若自己不持锁，固定遮罩背后的页面仍能用滚轮/PageDown 滚动。
 * 引用计数保证嵌套时只在最后一层释放时才恢复页面。
 */

let lockCount = 0
let savedScrollY = 0
let savedOverflow = ''
let savedPaddingRight = ''
let savedPosition = ''
let savedTop = ''
let savedWidth = ''

export function lockScroll(): void {
  if (lockCount === 0) {
    const { body, documentElement } = document
    savedScrollY = window.scrollY
    savedOverflow = body.style.overflow
    savedPaddingRight = body.style.paddingRight
    savedPosition = body.style.position
    savedTop = body.style.top
    savedWidth = body.style.width
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth
    // position:fixed also stops iOS Safari's rubber-band scroll of the page
    // behind the modal, which overflow:hidden alone does not.
    body.style.position = 'fixed'
    body.style.top = `-${savedScrollY}px`
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) {
      const current = parseFloat(getComputedStyle(body).paddingRight) || 0
      body.style.paddingRight = `${current + scrollbarWidth}px`
    }
  }
  lockCount++
}

export function unlockScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    const { body } = document
    body.style.overflow = savedOverflow
    body.style.paddingRight = savedPaddingRight
    body.style.position = savedPosition
    body.style.top = savedTop
    body.style.width = savedWidth
    window.scrollTo(0, savedScrollY)
  }
}
