import { useEffect, useState, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'

export const EmailVerify = () => {
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [errorMsg, setErrorMsg] = useState('')
  const verified = useRef(false)

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token || verified.current) {
      if (!token) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setStatus('error')
        setErrorMsg(t('emailVerify.error'))
      }
      return
    }
    verified.current = true
    const verify = async () => {
      const result = await post('/auth/email/verify', { token })
      if (result.ok) {
        setStatus('success')
      } else {
        setStatus('error')
        if (result.error.code === ERRORS.TOKEN_INVALID_OR_EXPIRED) {
          setErrorMsg(t('emailVerify.error'))
        } else {
          setErrorMsg(result.error.message || t('emailVerify.error'))
        }
      }
    }
    verify()
  }, [searchParams, t])

  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', textAlign: 'center', padding: '2rem' }}>
      {status === 'verifying' && (
        <h1 style={{ fontSize: '1.5rem', color: 'var(--text-main)' }}>{t('emailVerify.verifying')}</h1>
      )}
      {status === 'success' && (
        <>
          <h1 style={{ fontSize: '1.5rem', color: 'var(--success-color)' }}>{t('emailVerify.success')}</h1>
          <Link to="/login" style={{ marginTop: '1rem', color: 'var(--accent-pink)' }}>
            {t('emailVerify.redirectToLogin')}
          </Link>
        </>
      )}
      {status === 'error' && (
        <>
          <h1 style={{ fontSize: '1.5rem', color: 'var(--error-color)' }}>{t('emailVerify.title')}</h1>
          <p style={{ fontSize: '1rem', color: 'var(--text-secondary)' }} role="alert">{errorMsg}</p>
          <Link to="/auth/email/resend" style={{ marginTop: '1rem', color: 'var(--accent-pink)' }}>
            {t('emailResend.title')}
          </Link>
        </>
      )}
    </main>
  )
}
