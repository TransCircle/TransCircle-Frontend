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
import { useState, useRef, type ReactNode } from 'react'
import { StepUpDialog } from '@/components/StepUpDialog'

export function useStepUpAction(accessToken: string | null) {
  const [showStepUp, setShowStepUp] = useState(false)
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null)

  /** 记录待重放操作并打开对话框（收到 STEP_UP_REQUIRED 时调用）。 */
  const runWithStepUp = (action: () => Promise<void>): void => {
    pendingActionRef.current = action
    setShowStepUp(true)
  }

  const stepUpElement: ReactNode =
    showStepUp && accessToken ? (
      <StepUpDialog
        accessToken={accessToken}
        onSuccess={() => {
          setShowStepUp(false)
          const a = pendingActionRef.current
          pendingActionRef.current = null
          void a?.()
        }}
        onCancel={() => {
          setShowStepUp(false)
          pendingActionRef.current = null
        }}
      />
    ) : null

  return { showStepUp, runWithStepUp, stepUpElement }
}
