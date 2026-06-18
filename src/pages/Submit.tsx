import { useTranslation } from 'react-i18next'
import { SubmitForm } from '@/components/SubmitForm'
import styles from '../App.module.css'

export const Submit = () => {
  const { t } = useTranslation()

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('submitPage.title')}</h1>
        <p className={styles.subTitle}>
          {t('submitPage.description')}
        </p>
      </header>

      <SubmitForm />
    </>
  )
}
