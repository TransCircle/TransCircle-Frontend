/**
 * 全站浮层栈：只有栈顶的浮层响应 Esc 与 Tab 焦点环。
 *
 * 抽成独立模块而不是放在 Modal.tsx 里，是因为 Modal.tsx 只导出组件
 * （react-refresh 规则）；而且 StepUpDialog 这类非 Modal 浮层也要入栈。
 *
 * 必须入栈的原因：Modal 的键盘监听挂在 document 的**捕获**阶段，会早于任何
 * 挂在元素上的监听触发并 stopPropagation。上层浮层若不在栈里，底层 Modal 会
 * 抢走 Esc 把自己关掉，上层浮层永远收不到——操作因此被静默放弃。
 */

const stack: symbol[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/**
 * 订阅栈变化。浮层需要**响应式**地知道自己还是不是栈顶：
 * 只有栈顶那一层能声明 `aria-modal`，底下的必须让出（并设为 inert），
 * 否则辅助技术会同时面对两个都自称独占页面的对话框，无法在它们之间导航。
 */
export function subscribeModalStack(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 入栈，返回用于出栈的句柄。 */
export function pushModalLayer(label = 'layer'): symbol {
  const id = Symbol(label)
  stack.push(id)
  notify()
  return id
}

/** 出栈（幂等；已被移除时什么都不做）。 */
export function popModalLayer(id: symbol): void {
  const idx = stack.lastIndexOf(id)
  if (idx !== -1) {
    stack.splice(idx, 1)
    notify()
  }
}

/**
 * 当前是否有任何浮层开着。
 *
 * 抽屉（站点 Navbar / 后台 AdminShell）不是浮层栈的成员，但它们也在 document 上
 * 监听 Tab 做焦点循环。浮层开着时它们必须让开——否则 Tab 事件走完浮层的处理后
 * 继续冒泡到抽屉，抽屉发现「焦点不在我里面」就把它拽回侧栏，顶层对话框的
 * 焦点陷阱当场失效。
 */
export function hasModalLayer(): boolean {
  return stack.length > 0
}

/** 该层是否位于栈顶——非栈顶的浮层不处理键盘事件。 */
export function isTopModalLayer(id: symbol | null): boolean {
  return id !== null && stack[stack.length - 1] === id
}
