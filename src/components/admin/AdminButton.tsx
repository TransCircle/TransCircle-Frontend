import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Spinner } from './Feedback'
import { buttonClassName, type AdminButtonSize, type AdminButtonVariant } from './buttonClass'
import styles from './AdminButton.module.css'

export type { AdminButtonSize, AdminButtonVariant }

export interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AdminButtonVariant
  size?: AdminButtonSize
  fullWidth?: boolean
  loading?: boolean
  iconLeft?: ReactNode
}

export const AdminButton = forwardRef<HTMLButtonElement, AdminButtonProps>(function AdminButton(
  { variant = 'secondary', size = 'md', fullWidth, loading, iconLeft, disabled, children, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClassName(variant, size, fullWidth, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" inline />
      ) : iconLeft ? (
        <span className={styles.icon} aria-hidden="true">
          {iconLeft}
        </span>
      ) : null}
      {children != null && <span className={styles.label}>{children}</span>}
    </button>
  )
})

export interface ButtonLinkProps extends LinkProps {
  variant?: AdminButtonVariant
  size?: AdminButtonSize
  fullWidth?: boolean
  iconLeft?: ReactNode
}

/** 站内导航动作：保留 <a> 语义，外观与 AdminButton 完全一致。 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'secondary', size = 'md', fullWidth, iconLeft, children, className, ...rest },
  ref,
) {
  return (
    <Link ref={ref} className={buttonClassName(variant, size, fullWidth, className as string | undefined)} {...rest}>
      {iconLeft ? (
        <span className={styles.icon} aria-hidden="true">
          {iconLeft}
        </span>
      ) : null}
      {children != null && <span className={styles.label}>{children}</span>}
    </Link>
  )
})
