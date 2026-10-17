import { useTranslation } from 'react-i18next'
import { SubmitForm } from '@/components/SubmitForm'
import { Card, PageHeader } from '@/components/ui'
import shell from './Account.module.css'

export const Submit = () => {
  const { t } = useTranslation()

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <PageHeader title={t('submitPage.title')} description={t('submitPage.description')} />
      <Card>
        <SubmitForm />
      </Card>
    </div>
  )
}
