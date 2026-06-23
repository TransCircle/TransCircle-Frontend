import { useTranslation } from 'react-i18next'
import { SubmitForm } from '@/components/SubmitForm'
import { PageHeader } from '@/components/ui'
import shell from './Page.module.css'

export const Submit = () => {
  const { t } = useTranslation()

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <PageHeader title={t('submitPage.title')} description={t('submitPage.description')} />
      <SubmitForm />
    </div>
  )
}
