import { useRouteError, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { StatusScreen } from '@/components/ui'

export const ErrorBoundaryPage = () => {
  const error = useRouteError()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const isNotFound = error instanceof Response && error.status === 404
  const title = isNotFound ? t('notFound.title') : t('common.errorBoundaryTitle')
  const description = isNotFound ? t('notFound.description') : t('common.errorBoundaryDescription')
  const detail = error instanceof Response ? `(${error.status})` : undefined

  // Rendered outside RootLayout (router errorElement) → owns the page <main>.
  return (
    <StatusScreen
      as="main"
      kind="error"
      title={title}
      description={description}
      detail={detail}
      actions={[
        { label: t('common.backToHome'), variant: 'secondary', onClick: () => navigate('/', { replace: true }) },
      ]}
    />
  )
}
