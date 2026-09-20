import { useTranslation } from 'react-i18next'
import { StatusScreen } from '@/components/ui'

export const NotFound = () => {
  const { t } = useTranslation()

  return (
    <StatusScreen
      kind="error"
      showIcon
      title={t('notFound.title')}
      description={t('notFound.description')}
      actions={[{ label: t('notFound.backToHome'), to: '/' }]}
    />
  )
}
