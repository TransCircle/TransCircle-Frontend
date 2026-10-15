import type { ReactNode } from 'react'
import { cx } from '../admin/cx'
import { FlagStripe } from '../FlagStripe'
import styles from './AuthStage.module.css'

export interface AuthStageProps {
  children: ReactNode
  /** className applied to the inner card. */
  className?: string
  /** use 'main' only when rendered outside RootLayout. */
  as?: 'div' | 'main'
}

/**
 * 认证中转舞台（DESIGN.md §8，与 Pass 门户登录页 AuthSplit 同一版式）：
 * 整页舞台底（亮 --pink-100 / 暗 #1A1420）+ 顶部旗帜条纹 + 居中卡，卡顶居中正式
 * compact lockup。用户从故事站跳往 Pass 登录、或从 Pass 回跳时，前后两页视觉连贯。
 *
 * 只负责版式；内容（状态、标题、动作）全部由调用方提供。
 */
export function AuthStage({ children, className, as = 'div' }: AuthStageProps) {
  const Shell = as
  return (
    // data-viewport-fit：这页只有一屏，宽屏下由外壳锁成整屏、页脚常驻屏底。
    <Shell className={styles.stage} data-viewport-fit="">
      {/* scope="page"：页脚条纹据此让位，保证同一视口只有一处整条条纹（§1.5）。 */}
      <FlagStripe scope="page" />
      <div className={styles.cardSide}>
        <div className={styles.holder}>
          <div className={cx(styles.card, className)}>
            {/* 正式 compact lockup（public/brand），按主题二选一；文字已转 path，禁止拼装。
                两张图是同一标识，只让一处进无障碍树。 */}
            <div className={styles.lockup} role="img" aria-label="TransCircle">
              <img
                className={styles.lockupLight}
                src="/brand/transcircle-lockup-compact-on-light.svg"
                width={362}
                height={105}
                alt=""
                aria-hidden="true"
              />
              <img
                className={styles.lockupDark}
                src="/brand/transcircle-lockup-compact-on-dark.svg"
                width={359}
                height={100}
                alt=""
                aria-hidden="true"
              />
            </div>
            <div className={styles.body}>{children}</div>
          </div>
        </div>
      </div>
    </Shell>
  )
}
