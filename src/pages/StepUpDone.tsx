import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, tryRefreshToken } from '@/api/client'

/**
 * IAM 代理 2FA 回跳落地页（iam-admin-api.md §5.2）。
 * 用户在 IAM 完成通行密钥/TOTP 后回跳此处；前端调用后端 poll 回查权威结果，
 * 通过后回到发起危险操作的页面（5 分钟窗口内重发即可放行）。
 * 回跳 URL 上的 status 仅作提示、不可信；信任只来自后端回查。
 */
export const StepUpDone = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [state, setState] = useState<'polling' | 'verified' | 'failed'>('polling')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const run = async () => {
      const verificationId =
        params.get('verification_id') || sessionStorage.getItem('iamStepUpVerificationId') || ''
      const returnTo = sessionStorage.getItem('iamStepUpReturnTo') || '/admin'
      sessionStorage.removeItem('iamStepUpVerificationId')
      sessionStorage.removeItem('iamStepUpReturnTo')

      if (!verificationId) {
        setState('failed')
        return
      }
      try {
        // 整页跳转后内存中的 access token 已丢失：先用 refresh cookie 恢复，再回查
        await tryRefreshToken()
        const result = await post<{ verified?: boolean }>('/auth/step-up/iam/poll', { verificationId })
        if (result.ok && result.data.verified) {
          setState('verified')
          setTimeout(() => navigate(returnTo, { replace: true }), 1200)
        } else {
          setState('failed')
        }
      } catch {
        // 网络/刷新异常也归为失败，避免页面卡在 polling
        setState('failed')
      }
    }
    void run()
  }, [params, navigate])

  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', padding: '0 1rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.3rem', marginBottom: '1rem' }}>{t('stepUp.iamDoneTitle')}</h1>
      {state === 'polling' && <p style={{ color: 'var(--text-secondary)' }}>{t('stepUp.iamPolling')}</p>}
      {state === 'verified' && (
        <p style={{ color: 'var(--text-secondary)' }} role="status">{t('stepUp.iamVerified')}</p>
      )}
      {state === 'failed' && (
        <>
          <p style={{ color: 'var(--error-color)' }} role="alert">{t('stepUp.iamFailed')}</p>
          <button
            onClick={() => navigate('/admin', { replace: true })}
            style={{
              marginTop: '1rem', padding: '0.4rem 1rem', borderRadius: '50px',
              border: '1px solid var(--primary-pink)', background: 'none',
              color: 'var(--primary-pink)', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('stepUp.iamBack')}
          </button>
        </>
      )}
    </main>
  )
}
