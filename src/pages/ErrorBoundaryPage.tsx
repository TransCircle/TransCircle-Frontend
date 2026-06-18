import { useRouteError, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export const ErrorBoundaryPage = () => {
  const error = useRouteError()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const isNotFound = error instanceof Response && error.status === 404
  const title = isNotFound ? t('notFound.title', '页面未找到') : t('common.errorBoundaryTitle', '出错了')
  const description = isNotFound
    ? t('notFound.description', '你访问的页面不存在或已被移除。')
    : t('common.errorBoundaryDescription', '页面发生了意外错误，请稍后重试。')

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <h1 style={{ fontSize: '1.8rem', margin: '0 0 0.75rem', color: 'var(--accent-pink)' }}>
        {title}
      </h1>
      <p
        style={{
          fontSize: '1rem',
          color: 'var(--text-secondary)',
          margin: '0 0 1.5rem',
          maxWidth: '400px',
          lineHeight: 1.6,
        }}
        role="alert"
      >
        {description}
      </p>
      <button
        onClick={() => navigate('/', { replace: true })}
        style={{
          color: 'var(--accent-pink)',
          background: 'none',
          border: '1px solid var(--accent-pink)',
          padding: '0.5rem 1.25rem',
          borderRadius: '50px',
          fontSize: '0.9rem',
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {t('common.backToHome', '返回首页')}
      </button>
    </main>
  )
}
