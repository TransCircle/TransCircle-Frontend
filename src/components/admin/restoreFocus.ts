/**
 * 浮层关闭后的焦点还原。
 *
 * 直接 `el.focus()` 是不够的：浮层往往是由某个按钮触发的，而那个按钮在操作
 * 进行中会变成 disabled（loading 态），详情区也可能已经换成骨架屏、把它整个
 * 卸载掉。对 disabled 或已脱离文档的元素调 focus() 是静默失败的，焦点会掉回
 * body——键盘用户得从整页头部重新 Tab 一遍才能回到原处。
 *
 * 因此：能还原就还原；还不了、或者刚还原就又被卸载了，就退到仍开着的浮层里，
 * 再不然退到主内容区——总之留一个落脚点，别让键盘用户从整页头部重来。
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 焦点是不是「没人认领」——掉在 body / html 上。 */
export function focusIsOrphaned(): boolean {
  const a = document.activeElement
  return !a || a === document.body || a === document.documentElement
}

/* 看门狗的节奏：写操作成功后往往还跟着一次异步的列表刷新，刚拿到焦点的那一行
   可能因为条目移出当前筛选而被删掉。只看紧接着的一帧盖不住这个时序，所以在
   一段有界的窗口里回头查几次。 */
const WATCH_INTERVAL_MS = 150
const WATCH_MAX_CHECKS = 6

/**
 * 聚焦 el，并在随后的一小段时间里盯着它。
 *
 * 只有「这个元素被从文档里移除了」**且**「焦点无人认领」时才接管——用户自己
 * 点了空白处（元素还在、焦点变成 body）不算，那时抢焦点是骚扰。
 */
function focusAndWatch(el: HTMLElement): void {
  el.focus()
  let checks = 0
  const tick = () => {
    checks += 1
    if (!el.isConnected && focusIsOrphaned()) {
      focusFallback()
      return
    }
    if (checks < WATCH_MAX_CHECKS) window.setTimeout(tick, WATCH_INTERVAL_MS)
  }
  window.setTimeout(tick, WATCH_INTERVAL_MS)
}

export function restoreFocus(el: HTMLElement | null): void {
  if (el?.isConnected && !(el as HTMLButtonElement).disabled) {
    focusAndWatch(el)
    return
  }
  focusFallback()
}

/** 供 useDetailFocus 复用：聚焦某一行并盯着它别被随后的列表刷新删掉。 */
export function focusRowAndWatch(el: HTMLElement): void {
  focusAndWatch(el)
}

function focusFallback(): void {
  /* 下面还压着别的浮层（step-up 常常开在理由弹窗之上，验证成功后重放会让理由
     弹窗进入提交态、原来的触发按钮变成 disabled）：焦点必须留在那个浮层里，
     退到 <main> 会把用户丢到弹窗外面，得再按一次 Tab 才被陷阱拉回来。
     取最后一个未 inert 的 dialog——非栈顶的浮层都带着 inert。 */
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]:not([inert])')
  const top = dialogs[dialogs.length - 1]
  if (top) {
    const focusable = Array.from(top.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (n) => n.offsetParent !== null,
    )
    if (focusable) focusable.focus()
    else {
      if (!top.hasAttribute('tabindex')) top.tabIndex = -1
      top.focus()
    }
    return
  }

  const main = document.querySelector<HTMLElement>('main')
  if (!main) return
  // <main> 默认不可聚焦，补一个 -1 让它能作为程序化焦点的落点（不进 tab 序）
  if (!main.hasAttribute('tabindex')) main.tabIndex = -1
  main.focus()
}
