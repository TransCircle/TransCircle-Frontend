import { useTranslation } from 'react-i18next'
import { ButtonLink, EmptyState } from '@/components/ui'
import styles from './GuardStates.module.css'

const LockIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    <path d="M12 15v2" />
  </svg>
)

/** 路由守卫的「无权访问」：图标 + 说明 + 回首页出口，不让用户停在死胡同里。 */
export function AccessDenied({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation()
  return (
    <div className={styles.denied}>
      <EmptyState
        title={title}
        description={description}
        icon={<LockIcon />}
        action={
          <ButtonLink variant="secondary" to="/">
            {t('notFound.backToHome')}
          </ButtonLink>
        }
      />
    </div>
  )
}
