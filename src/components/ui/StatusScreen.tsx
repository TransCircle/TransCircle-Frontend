import type { ReactNode } from 'react'
import { cx } from '../admin/cx'
import { AdminButton, ButtonLink, Spinner, type AdminButtonVariant } from '../admin'
import { AuthStage } from './AuthStage'
import { BrandText } from './BrandText'
import { CenteredCard } from './CenteredCard'
import { PageHeader } from './PageHeader'
import styles from './StatusScreen.module.css'

export type StatusKind = 'loading' | 'success' | 'error' | 'info'

export interface StatusAction {
  label: string
  /** react-router target — rendered as a Link styled like a button. */
  to?: string
  onClick?: () => void
  variant?: AdminButtonVariant
  loading?: boolean
}

export interface StatusScreenProps {
  kind: StatusKind
  title: string
  description?: ReactNode
  /** small monospace detail line (e.g. an error code). */
  detail?: string
  actions?: StatusAction[]
  icon?: ReactNode
  showIcon?: boolean
  maxWidth?: string
  /** use 'main' only when rendered outside RootLayout (router errorElement). */
  as?: 'div' | 'main'
  /**
   * card = 居中玻璃卡（404、错误边界等普通状态页）；
   * stage = 认证舞台（登录中转、OAuth 回调、二次验证完成、认证报错），与 Pass 登录页同一版式。
   */
  variant?: 'card' | 'stage'
}

const SuccessIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="48"
    height="48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m8 12 3 3 5-6" />
  </svg>
)
const ErrorIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="48"
    height="48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v5" />
    <path d="M12 16h.01" />
  </svg>
)
const InfoIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="48"
    height="48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
)

const ICONS: Record<Exclude<StatusKind, 'loading'>, ReactNode> = {
  success: <SuccessIcon />,
  error: <ErrorIcon />,
  info: <InfoIcon />,
}

/**
 * 共享的结果屏（loading / success / error / info）：Spinner + PageHeader + 动作按钮，
 * 按 kind 给出正确的 live region 角色。外壳按 variant 取居中卡或认证舞台；
 * 标题中的品牌词经 BrandText 走品牌字体。
 */
export function StatusScreen({
  kind,
  title,
  description,
  detail,
  actions,
  icon,
  showIcon = true,
  maxWidth,
  as = 'div',
  variant = 'card',
}: StatusScreenProps) {
  const content = (
    <div
      className={cx(styles.inner, styles[kind])}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
    >
      {showIcon && (
        <span className={styles.icon} aria-hidden="true">
          {icon ?? (kind === 'loading' ? <Spinner size="lg" inline /> : ICONS[kind])}
        </span>
      )}
      <PageHeader title={<BrandText text={title} />} description={description} align="center" size="card" as="h1" />
      {detail && <p className={styles.detail}>{detail}</p>}
      {actions && actions.length > 0 && (
        <div className={styles.actions}>
          {actions.map((a, i) => {
            const buttonVariant = a.variant ?? (i === 0 ? 'primary' : 'secondary')
            if (a.to) {
              return (
                <ButtonLink key={i} to={a.to} variant={buttonVariant}>
                  {a.label}
                </ButtonLink>
              )
            }
            return (
              <AdminButton key={i} variant={buttonVariant} loading={a.loading} onClick={a.onClick}>
                {a.label}
              </AdminButton>
            )
          })}
        </div>
      )}
    </div>
  )
  return variant === 'stage' ? (
    <AuthStage as={as}>{content}</AuthStage>
  ) : (
    <CenteredCard maxWidth={maxWidth} as={as}>
      {content}
    </CenteredCard>
  )
}
