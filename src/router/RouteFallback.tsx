import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AdminButton, AuthStage, CenteredCard, Spinner } from '@/components/ui'
import styles from './RouteFallback.module.css'

/**
 * 懒加载占位的版式，必须与目标路由的根外壳一致，否则 chunk 落地前后会换外壳：
 * - stage：目标是认证舞台（登录中转、回调、二次验证完成、认证报错）
 * - card：目标是居中卡（404）
 * - page：普通长页面；只占一段高度，不自报 data-viewport-fit，
 *   以免宽屏下先锁一屏、落地后又解锁，页脚位置来回跳。
 * - inline：嵌在已有外壳里（后台工作区），不再叠加页面内边距。
 */
export type RouteFallbackLayout = 'stage' | 'card' | 'page' | 'inline'

function Shell({ layout, children }: { layout: RouteFallbackLayout; children: ReactNode }) {
  if (layout === 'stage') return <AuthStage>{children}</AuthStage>
  if (layout === 'card') return <CenteredCard>{children}</CenteredCard>
  if (layout === 'inline') return <div className={styles.inline}>{children}</div>
  return <div className={styles.page}>{children}</div>
}

/** label：读屏播报的加载说明，缺省为通用「加载中」。 */
export function RouteLoading({ layout, label }: { layout: RouteFallbackLayout; label?: string }) {
  const { t } = useTranslation()
  return (
    <Shell layout={layout}>
      <div className={styles.loading} role="status" aria-live="polite" aria-busy="true">
        <Spinner size="lg" inline />
        <span className={styles.srOnly}>{label ?? t('common.loading')}</span>
      </div>
    </Shell>
  )
}

export function RouteLoadError({ layout, onRetry }: { layout: RouteFallbackLayout; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Shell layout={layout}>
      <div className={styles.error} role="alert">
        <p className={styles.errorText}>{t('common.chunkLoadError')}</p>
        <AdminButton variant="primary" onClick={onRetry}>
          {t('common.retry')}
        </AdminButton>
      </div>
    </Shell>
  )
}
