import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import { StatusScreen } from '@/components/ui'

export const EmailVerify = () => {
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()

  // Determine initial state from URL params synchronously (H4)
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>(
    token ? 'verifying' : 'error',
  )
  const [errorMsg, setErrorMsg] = useState<string>(
    token ? '' : t('emailVerify.noToken'),
  )
  const processed = useRef<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) return // already handled via initial state
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

  if (status === 'verifying') {
    return <StatusScreen kind="loading" title={t('emailVerify.verifying')} />
  }
  if (status === 'success') {
    return (
      <StatusScreen
        kind="success"
        title={t('emailVerify.success')}
        actions={[{ label: t('emailVerify.redirectToLogin'), to: '/login' }]}
      />
    )
  }
  return (
    <StatusScreen
      kind="error"
      title={t('emailVerify.title')}
      description={errorMsg}
      actions={[{ label: t('emailResend.title'), to: '/auth/email/resend' }]}
    />
  )
}
