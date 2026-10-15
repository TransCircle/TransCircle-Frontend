import { cx } from './cx'
import styles from './AdminButton.module.css'

export type AdminButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type AdminButtonSize = 'sm' | 'md'

/** 按钮外观类名：供需要保留链接语义（新标签打开、右键复制地址）的导航动作复用同一几何。 */
export function buttonClassName(
  variant: AdminButtonVariant = 'secondary',
  size: AdminButtonSize = 'md',
  fullWidth = false,
  className?: string,
): string {
  return cx(styles.btn, styles[variant], styles[size], fullWidth && styles.fullWidth, className)
}
