import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { AdminButton } from './AdminButton'
import { Alert } from './Feedback'
import { TextField } from './Field'
import styles from './Modal.module.css'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE)
  if (nodes.length === 0) {
    e.preventDefault()
    return
  }
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  const active = document.activeElement
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault()
      last.focus()
    }
  } else if (active === last) {
    e.preventDefault()
    first.focus()
  }
}

/* ── Body scroll lock (refcounted) + modal stack ─────────── */

const modalStack: symbol[] = []
let lockCount = 0
let savedScrollY = 0
let savedOverflow = ''
let savedPaddingRight = ''
let savedPosition = ''
let savedTop = ''
let savedWidth = ''

function lockScroll() {
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

function unlockScroll() {
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
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const stackIdRef = useRef<symbol | null>(null)
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`

  useEffect(() => {
    if (!open) return
    const id = Symbol('modal')
    stackIdRef.current = id
    modalStack.push(id)
    restoreRef.current = document.activeElement as HTMLElement | null
    lockScroll()

    const focusTarget =
      initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current
    focusTarget?.focus()

    return () => {
      const idx = modalStack.lastIndexOf(id)
      if (idx !== -1) modalStack.splice(idx, 1)
      stackIdRef.current = null
      unlockScroll()
      restoreRef.current?.focus?.()
    }
    // initialFocusRef is read once on open; intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most modal handles Esc / focus-trap Tab, so stacked
      // dialogs neither co-close nor fight over focus.
      if (modalStack[modalStack.length - 1] !== stackIdRef.current) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') trapFocus(e, panelRef.current)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (closeOnOverlayClick && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
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
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      size="sm"
      initialFocusRef={variant === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <AdminButton ref={cancelRef} variant="secondary" onClick={onCancel}>
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
    />
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
      initialFocusRef={inputRef}
      footer={
        <>
          <AdminButton variant="secondary" onClick={onCancel}>
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
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
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
