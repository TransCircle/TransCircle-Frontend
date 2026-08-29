/**
 * useStepUpAction —— 收敛「危险操作遇 STEP_UP_REQUIRED → 弹 StepUpDialog → onSuccess 重放原操作」模式。
 *
 * 该模式此前在 Admin.tsx（发布/隐藏/删除）与 AdminUsers.tsx（封禁/解封）各复制一份，
 * 未来新增需 2FA 的操作（如编辑申请通过）会再复制第三份。本 hook 统一持有：
 * - showStepUp 对话框显隐
 * - pendingActionRef 待重放的操作（onSuccess 后执行）
 * - stepUpElement 可直接渲染的 <StepUpDialog>（在组件 JSX 中插入一次）
 *
 * 用法：
 *   const { stepUpElement, runWithStepUp } = useStepUpAction(accessToken)
 *   // 操作收到 STEP_UP_REQUIRED 时：
 *   runWithStepUp(doAction)   // 内部 setShowStepUp(true)
 *   // JSX 末尾：
 *   {stepUpElement}
 */
import { useState, useRef, useCallback, type ReactNode } from 'react'
import { StepUpDialog } from '@/components/StepUpDialog'

export function useStepUpAction(accessToken: string | null) {
  const [showStepUp, setShowStepUp] = useState(false)
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null)
  const onSettledRef = useRef<(() => void) | null>(null)

  /**
   * 记录待重放操作并打开对话框（收到 STEP_UP_REQUIRED 时调用）。
   *
   * `onSettled` 在整个流程真正结束时调用一次——重放执行完毕，或用户取消。
   * 调用方若持有「操作进行中」的锁，必须在这里释放：`runWithStepUp` 本身
   * 只是登记后立即返回，此时操作远未结束，在它之后释放锁等于没有锁。
   */
  const runWithStepUp = (action: () => Promise<void>, onSettled?: () => void): void => {
    /* 没有 access token 时对话框根本不会渲染（见下方 stepUpElement 的条件），
       onSuccess/onCancel 就永远不会被调用——调用方那把「操作进行中」的锁会
       就此永久卡住。这种情况下直接判定本轮结束，把锁还回去。 */
    if (!accessToken) {
      onSettled?.()
      return
    }
    pendingActionRef.current = action
    onSettledRef.current = onSettled ?? null
    setShowStepUp(true)
  }

  /* 两个回调必须是稳定引用：StepUpDialog 的焦点陷阱 effect 依赖 onCancel，
     内联箭头会让父组件的任意一次重渲染都重跑 effect——先把焦点还给背景元素，
     再抓回对话框的第一个可聚焦元素，用户在验证码输入框里打到一半就被踢回开头。
     两者只用到 setState 与 ref，因此空依赖即可。 */
  const handleSuccess = useCallback(() => {
    setShowStepUp(false)
    const a = pendingActionRef.current
    const settled = onSettledRef.current
    pendingActionRef.current = null
    onSettledRef.current = null
    void (async () => {
      try {
        await a?.()
      } finally {
        // 重放过程中若又触发一次 step-up，锁应交给新的那一轮释放
        if (!pendingActionRef.current) settled?.()
      }
    })()
  }, [])

  const handleCancel = useCallback(() => {
    setShowStepUp(false)
    pendingActionRef.current = null
    const settled = onSettledRef.current
    onSettledRef.current = null
    settled?.()
  }, [])

  const stepUpElement: ReactNode =
    showStepUp && accessToken ? (
      <StepUpDialog accessToken={accessToken} onSuccess={handleSuccess} onCancel={handleCancel} />
    ) : null

  return { showStepUp, runWithStepUp, stepUpElement }
}
