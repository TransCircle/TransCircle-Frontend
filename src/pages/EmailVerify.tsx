import { useEffect, useState, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'

export const EmailVerify = () => {
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [errorMsg, setErrorMsg] = useState('')
  const processed = useRef<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      // Missing token is a non-actionable state
      return
    }
    if (processed.current === token) return
    processed.current = token

    const abortCtrl = new AbortController()
    const timeoutId = setTimeout(() => abortCtrl.abort(), 30_000)

    const verify = async () => {
      try {
        const result = await post('/auth/email/verify', { token }, { signal: abortCtrl.signal })
        if (abortCtrl.signal.aborted) return
        if (result.ok) {
          setStatus('success')
        } else {
          setStatus('error')
          setErrorMsg(result.error.message || t('emailVerify.error'))
        }
      } catch {
        if (!abortCtrl.signal.aborted) {
          setStatus('error')
          setErrorMsg(t('emailVerify.error'))
        }
      }
    }
    verify()
    return () => {
      clearTimeout(timeoutId)
      abortCtrl.abort()
    }
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
