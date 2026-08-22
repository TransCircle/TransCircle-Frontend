import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { AdminButton } from './AdminButton'
import { Alert } from './Feedback'
import { TextField } from './Field'
import { pushModalLayer, popModalLayer, isTopModalLayer, subscribeModalStack } from './modalStack'
import { lockScroll, unlockScroll } from './scrollLock'
import { restoreFocus } from './restoreFocus'
import styles from './Modal.module.css'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE)
  if (nodes.length === 0) {
    /* 提交进行中时确认与取消都被禁用，弹窗里一个可聚焦元素都不剩。
       只 preventDefault 的话焦点会僵在被禁用的按钮或 body 上，读屏用户
       既听不到弹窗内容也走不出去。把焦点交给面板本身（tabIndex=-1），
       内容至少可读、可朗读，Tab 仍被拦在弹窗内。
       注意不能只在「焦点在弹窗外」时才这么做：焦点停在弹窗**内部**某个
       已禁用的按钮上时同样动弹不得，那才是最常见的情形。 */
    e.preventDefault()
    if (document.activeElement !== container) container.focus()
    return
  }
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  const active = document.activeElement
  /* 焦点已经在弹窗外（提交期间控件被禁用后焦点会掉到 body）：正反向都要拉回来。
     只处理 Shift+Tab 的话，正向 Tab 会从 body 一路走进背景页面。 */
  if (!container.contains(active)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  /* 焦点停在容器本身（上一轮「全禁用」时的兜底落点）：它既不是第一个也不是
     最后一个控件，不接管的话浏览器会按文档顺序把焦点送出弹窗。 */
  if (active === container) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey) {
    if (active === first) {
      e.preventDefault()
      last.focus()
    }
  } else if (active === last) {
    e.preventDefault()
    first.focus()
  }
}

/* ── Modal base ──────────────────────────────────────────── */

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md'
  closeOnOverlayClick?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  /**
   * 请求进行中：Esc、遮罩点击一律不关闭（调用方还应禁用取消按钮）。
   *
   * 不锁的话会出现这样的时序：对 A 发起操作 → 请求在途时按 Esc 关掉弹窗 →
   * 立刻对 B 打开同一个弹窗 → A 的响应返回，它的成功分支执行
   * `setXxxTarget(null)`，把 B 的弹窗连同用户刚填的理由一起抹掉。
   */
  busy?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'sm',
  closeOnOverlayClick = true,
  initialFocusRef,
  busy = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const stackIdRef = useRef<symbol | null>(null)
  /* 是否是栈顶那一层。step-up 弹窗常常开在本弹窗之上，那时本弹窗必须让出
     aria-modal 并设为 inert——两个对话框同时自称独占页面的话，辅助技术
     无法在它们之间正确导航，上层的 step-up 可能根本读不到。 */
  const [isTop, setIsTop] = useState(true)
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`

  useEffect(() => {
    if (!open) return
    const id = pushModalLayer('modal')
    stackIdRef.current = id
    restoreRef.current = document.activeElement as HTMLElement | null
    lockScroll()

    const focusTarget =
      initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current
    focusTarget?.focus()

    return () => {
      popModalLayer(id)
      stackIdRef.current = null
      unlockScroll()
      restoreFocus(restoreRef.current)
    }
    // initialFocusRef is read once on open; intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const sync = () => setIsTop(isTopModalLayer(stackIdRef.current))
    sync()
    return subscribeModalStack(sync)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most modal handles Esc / focus-trap Tab, so stacked
      // dialogs neither co-close nor fight over focus.
      if (!isTopModalLayer(stackIdRef.current)) return
      if (e.key === 'Escape') {
        // 提交进行中：吞掉 Esc，既不关闭自己也不让它落到别处
        e.stopPropagation()
        if (busy) return
        onClose()
        return
      }
      if (e.key === 'Tab') trapFocus(e, panelRef.current)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose, busy])

  if (!open) return null

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (busy) return
        if (closeOnOverlayClick && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isTop || undefined}
        inert={!isTop || undefined}
        // 供「无可聚焦元素」时兜底聚焦（见 trapFocus）；没有它 .focus() 是空操作
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx(styles.panel, size === 'md' && styles.panelMd)}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {description && (
          <p id={descId} className={styles.desc}>
            {description}
          </p>
        )}
        {children && <div className={styles.body}>{children}</div>}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ── ConfirmDialog (replaces window.confirm) ─────────────── */

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  onConfirm: () => void
  onCancel: () => void
  variant?: 'default' | 'danger'
  confirmLoading?: boolean
  /**
   * 失败提示。必须渲染在弹窗**内部**：确认失败时对话框不会关闭，而遮罩、滚动锁
   * 和焦点陷阱都还生效——把提示放在弹窗外面，用户既看不到也够不着，只会看到
   * 按钮重新变得可点，以为什么都没发生。
   */
  error?: string
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  variant = 'default',
  confirmLoading,
  error,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      size="sm"
      busy={confirmLoading}
      initialFocusRef={variant === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <AdminButton ref={cancelRef} variant="secondary" onClick={onCancel} disabled={confirmLoading}>
            {cancelText}
          </AdminButton>
          <AdminButton
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={confirmLoading}
          >
            {confirmText}
          </AdminButton>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  )
}

/* ── ReasonPromptDialog (replaces inline reason rows) ────── */

export interface ReasonPromptDialogProps {
  open: boolean
  title: string
  prompt: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  submitText: string
  cancelText: string
  maxLength: number
  counterText?: string
  error?: string
  variant?: 'default' | 'danger'
  submitting?: boolean
}

export function ReasonPromptDialog({
  open,
  title,
  prompt,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitText,
  cancelText,
  maxLength,
  counterText,
  error,
  variant = 'default',
  submitting,
}: ReasonPromptDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      busy={submitting}
      initialFocusRef={inputRef}
      footer={
        <>
          <AdminButton variant="secondary" onClick={onCancel} disabled={submitting}>
            {cancelText}
          </AdminButton>
          <AdminButton variant={variant === 'danger' ? 'danger' : 'primary'} onClick={onSubmit} loading={submitting}>
            {submitText}
          </AdminButton>
        </>
      }
    >
      <p className={styles.prompt}>{prompt}</p>
      <TextField
        ref={inputRef}
        value={value}
        /* 提交期间冻结：请求带走的是点下按钮那一刻的理由，此时还能改的话，
           屏幕上显示的和实际发出去的就不是同一句话；成功后又会清空用户
           刚敲进去的新内容。焦点陷阱有面板的 tabIndex=-1 兜底，不会因此失效。 */
        disabled={submitting}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={prompt}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter 也要尊重进行中状态，否则请求在途时连按会重复提交
          if (e.key === 'Enter' && !submitting) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      {counterText && <div className={styles.counter}>{counterText}</div>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  )
}
