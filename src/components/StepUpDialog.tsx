import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { post, setAccessToken, getAccessToken } from '@/api/client'
import { arrayBufferToBase64url, base64urlToArrayBuffer } from '@/utils/string'
import { useAuth } from '@/context/useAuth'
import { Select } from '@/components/ui'
import styles from './StepUpDialog.module.css'

interface StepUpDialogProps {
  onSuccess: () => void
  onCancel: () => void
  /** 用于 API 认证的 Bearer Token — api.md §1.12 要求 */
  accessToken: string
}

type StepUpMethod = 'password' | 'passkey' | 'totp' | 'recovery_code'
/** IAM 代理 2FA 的弹窗子状态：发起 → 等待弹窗 → 回查 → 成功。 */
type IamPhase = 'iam' | 'waiting' | 'polling' | 'verified'

// 回传信号到达时后端通常已标记验证（与整页回跳的单次回查一致）；少量重试容忍提交延迟。
const IAM_POLL_ATTEMPTS = 10
const IAM_POLL_INTERVAL_MS = 600
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface StartResponse {
  challengeId: string
  expiresIn: number
  availableMethods: StepUpMethod[]
  passkey?: {
    publicKey: {
      challenge: string
      rpId: string
      userVerification: string
      allowCredentials: Array<{
        id: string
        type: 'public-key'
        transports: string[]
      }>
    }
  }
}

const CheckIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const StepUpDialog = ({ onSuccess, onCancel, accessToken }: StepUpDialogProps) => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [challengeId, setChallengeId] = useState('')
  const [availableMethods, setAvailableMethods] = useState<StepUpMethod[]>([])
  const [passkeyChallenge, setPasskeyChallenge] = useState<StartResponse['passkey'] | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<StepUpMethod | null>(null)
  // IAM 账号无本地因子 → 走 IAM 代理 2FA（弹窗 verify_url，主窗口保持对话框打开）
  const [iamMode, setIamMode] = useState(false)
  const [iamPhase, setIamPhase] = useState<IamPhase>('iam')
  const iamVerificationIdRef = useRef<string>('')
  const popupRef = useRef<Window | null>(null)
  // 防止「回传消息」与「弹窗关闭轮询」对同一次验证重复回查。
  const iamPolledRef = useRef(false)
  // 供按键处理闭包读取当前 IAM 阶段（闭包 deps 为 [onCancel]，不会响应式捕获 iamPhase）。
  const iamPhaseRef = useRef<IamPhase>('iam')
  // 成功后自动重放的定时器：卸载时需清理，避免在错误时机触发。
  const successTimerRef = useRef<number | null>(null)

  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  /** Tracks whether handlePasskey has been triggered (for render — ref is used for the actual guard) */
  const [passkeyProcessing, setPasskeyProcessing] = useState(false)

  const passkeyProcessed = useRef(false)

  // Sync accessToken into client memory so step-up API calls use correct auth.
  // Restore the previous token on unmount to avoid leaking the dialog's token
  // to subsequent API calls from other components.
  useEffect(() => {
    const prevToken = getAccessToken()
    if (accessToken) setAccessToken(accessToken)
    return () => setAccessToken(prevToken)
  }, [accessToken])

  // Focus trap: trap focus inside dialog when open
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const restore = document.activeElement as HTMLElement | null
    // 实时查询可聚焦元素（异步加载方式 / 切换到 IAM 模式后 DOM 会变化，不能用挂载时的快照），
    // 并过滤掉不可见（如移动端隐藏的折叠按钮）节点。
    const visibleFocusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(n => n.offsetParent !== null || n === document.activeElement)
    visibleFocusables()[0]?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 验证成功 / 回查进行中不响应 Escape，避免打断自动重放导致已验证操作被丢弃
        if (iamPhaseRef.current === 'verified' || iamPhaseRef.current === 'polling') return
        onCancel(); return
      }
      if (e.key !== 'Tab') return
      const nodes = visibleFocusables()
      if (nodes.length === 0) { e.preventDefault(); return }
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      if (e.shiftKey) {
        if (document.activeElement === first || !el.contains(document.activeElement)) { e.preventDefault(); last.focus() }
      } else if (document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    el.addEventListener('keydown', handler)
    return () => {
      el.removeEventListener('keydown', handler)
      restore?.focus?.()
    }
  }, [onCancel])

  // Fetch available methods on mount
  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false
    const init = async () => {
      const result = await post<StartResponse>(
        '/auth/step-up/start',
        {},
        { signal: ac.signal },
      )
      if (cancelled) return
      const methods = result.ok ? (result.data.availableMethods || []) : []
      if (result.ok && result.data.challengeId && methods.length > 0) {
        setChallengeId(result.data.challengeId)
        setAvailableMethods(methods)
        setPasskeyChallenge(result.data.passkey ?? null)
        // Default to password, fallback to first available
        setSelectedMethod(methods.includes('password') ? 'password' : (methods[0] ?? null))
        return
      }
      // 无可用本地因子：IAM 账号改走代理 2FA，否则报错
      if (user?.iamLinked) {
        setIamMode(true)
        return
      }
      setError(t('stepUp.errorInit'))
    }
    init()
    return () => { cancelled = true; ac.abort() }
  }, [accessToken, t, user])

  // ── IAM 代理 2FA：弹窗流程（避免整页跳转丢失发起页状态）──────

  // 后端权威回查（主窗口持有有效 access token；弹窗仅负责回传信号后自行关闭）
  const pollIamResult = async (afterPopupClose = false) => {
    if (iamPolledRef.current) return
    iamPolledRef.current = true
    const vid = iamVerificationIdRef.current
    if (!vid) {
      iamPolledRef.current = false
      setIamPhase('iam')
      if (!afterPopupClose) setError(t('stepUp.iamFailed'))
      return
    }
    setIamPhase('polling')
    setError('')
    // 后端 IAM 回调提交可能略晚于弹窗回传信号：短间隔重试若干次后再判失败（回查为权威）
    for (let attempt = 0; attempt < IAM_POLL_ATTEMPTS; attempt++) {
      try {
        const result = await post<{ verified?: boolean }>('/auth/step-up/iam/poll', { verificationId: vid })
        if (result.ok && result.data.verified) {
          setIamPhase('verified')
          // 成功态展示片刻后自动重放原操作（无需管理员二次确认）
          successTimerRef.current = window.setTimeout(() => onSuccess(), 900)
          return
        }
      } catch {
        // 忽略本次异常，继续重试
      }
      await new Promise(resolve => window.setTimeout(resolve, IAM_POLL_INTERVAL_MS))
    }
    // 多次回查仍未通过：解除回查闩锁以允许后续重试，回到发起态
    iamPolledRef.current = false
    setIamPhase('iam')
    if (!afterPopupClose) setError(t('stepUp.iamFailed'))
  }

  // 等待弹窗：监听回传消息 + 轮询弹窗是否被关闭
  useEffect(() => {
    if (iamPhase !== 'waiting') return
    const onMessage = (e: MessageEvent) => {
      // 仅接受来自本次打开的弹窗、且匹配当前 verificationId 的同源消息，避免被陈旧/伪造同源消息触发
      if (e.origin !== window.location.origin) return
      if (e.source !== popupRef.current) return
      const data = e.data as { type?: string; verificationId?: string } | null
      if (data?.type !== 'tc-iam-step-up-return') return
      if (data.verificationId && data.verificationId !== iamVerificationIdRef.current) return
      void pollIamResult()
    }
    window.addEventListener('message', onMessage)
    const interval = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        window.clearInterval(interval)
        void pollIamResult(true)
      }
    }, 800)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iamPhase])

  // 同步当前 IAM 阶段到 ref（供按键闭包读取）
  useEffect(() => { iamPhaseRef.current = iamPhase }, [iamPhase])

  // 对话框卸载时关闭可能仍开着的弹窗，并清理成功重放定时器
  useEffect(() => () => {
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close()
    if (successTimerRef.current) window.clearTimeout(successTimerRef.current)
  }, [])

  const handleIamStepUp = async () => {
    setSubmitting(true)
    setError('')
    iamPolledRef.current = false
    const result = await post<{ verifyUrl?: string; verificationId?: string }>('/auth/step-up/iam/start', {})
    if (!result.ok || !result.data.verifyUrl || !result.data.verificationId) {
      setError(t('stepUp.iamStartError'))
      setSubmitting(false)
      return
    }
    iamVerificationIdRef.current = result.data.verificationId
    // 兜底：弹窗被拦截时退回整页跳转，沿用 StepUpDone 的回查逻辑
    sessionStorage.setItem('iamStepUpVerificationId', result.data.verificationId)
    sessionStorage.setItem('iamStepUpReturnTo', window.location.pathname + window.location.search)
    const popup = window.open(
      result.data.verifyUrl,
      'tc-iam-stepup',
      'width=480,height=720,menubar=no,toolbar=no,location=yes',
    )
    if (!popup) {
      // 弹窗被拦截 → 退回整页跳转
      window.location.href = result.data.verifyUrl
      return
    }
    popupRef.current = popup
    setSubmitting(false)
    setIamPhase('waiting')
  }

  const handleSubmit = async () => {
    if (!challengeId || !selectedMethod) return
    setSubmitting(true)
    setError('')

    try {
      const body: Record<string, unknown> = { challengeId, method: selectedMethod }

      if (selectedMethod === 'password') {
        if (!password) {
          setError(t('stepUp.errorPasswordEmpty'))
          setSubmitting(false)
          return
        }
        body.password = password
      } else if (selectedMethod === 'totp' || selectedMethod === 'recovery_code') {
        if (!code) {
          setError(t('stepUp.errorCodeEmpty'))
          setSubmitting(false)
          return
        }
        body.code = code
      } else if (selectedMethod === 'passkey') {
        setSubmitting(false)
        return
      }

      const result = await post('/auth/step-up/verify', body)

      if (!result.ok) {
        throw new Error(result.error.message || t('stepUp.errorFailed'))
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('stepUp.errorFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasskey = async () => {
    if (!challengeId || !passkeyChallenge || passkeyProcessed.current) return
    passkeyProcessed.current = true
    setPasskeyProcessing(true)
    setSubmitting(true)
    setError('')

    try {
      // Convert base64url challenge to ArrayBuffer for WebAuthn API
      const allowCreds: PublicKeyCredentialDescriptor[] | undefined =
        passkeyChallenge.publicKey.allowCredentials?.map((c: { id: string; type: 'public-key'; transports: string[] }) => ({
          type: 'public-key' as const,
          id: base64urlToArrayBuffer(c.id),
          transports: c.transports as AuthenticatorTransport[],
        }))
      const publicKeyCredOpts: PublicKeyCredentialRequestOptions = {
        challenge: base64urlToArrayBuffer(passkeyChallenge.publicKey.challenge),
        rpId: passkeyChallenge.publicKey.rpId,
        userVerification: passkeyChallenge.publicKey.userVerification as UserVerificationRequirement,
        allowCredentials: allowCreds,
      }
      const credential = await navigator.credentials.get({ publicKey: publicKeyCredOpts })

      if (!credential) {
        setError(t('stepUp.errorUserCancel'))
        setSubmitting(false)
        return
      }

      const pkCred = credential as PublicKeyCredential
      const response = pkCred.response as AuthenticatorAssertionResponse

      const result = await post('/auth/step-up/verify', {
        challengeId,
        method: 'passkey',
        passkeyAssertion: {
          id: arrayBufferToBase64url(pkCred.rawId),
          rawId: arrayBufferToBase64url(pkCred.rawId),
          type: pkCred.type,
          response: {
            clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
            authenticatorData: arrayBufferToBase64url(response.authenticatorData),
            signature: arrayBufferToBase64url(response.signature),
            userHandle: response.userHandle ? arrayBufferToBase64url(response.userHandle) : null,
          },
          clientExtensionResults: pkCred.getClientExtensionResults(),
        },
      })

      if (!result.ok) {
        throw new Error(result.error.message || t('stepUp.errorPasskeyFailed'))
      }

      onSuccess()
    } catch (err) {
      passkeyProcessed.current = false  // Allow retry on cancel/error
      setPasskeyProcessing(false)
      setError(err instanceof Error ? err.message : t('stepUp.errorPasskeyFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  // Reset passkey guard when method switches away from passkey (M7)
  useEffect(() => {
    if (selectedMethod !== 'passkey') {
      passkeyProcessed.current = false
    }
  }, [selectedMethod])

  // Auto-trigger passkey flow when selected
  useEffect(() => {
    if (selectedMethod === 'passkey' && challengeId && passkeyChallenge) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      handlePasskey()
    }
    // Only run when selectedMethod changes to passkey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMethod, challengeId, passkeyChallenge])

  const methodLabels: Record<StepUpMethod, string> = {
    password: t('stepUp.methodPassword'),
    passkey: t('stepUp.methodPasskey'),
    totp: t('stepUp.methodTotp'),
    recovery_code: t('stepUp.methodRecoveryCode'),
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      className={styles.overlay}
    >
      <div className={styles.panel}>
        <h3 id="stepup-title" className={styles.title}>{t('stepUp.title')}</h3>
        <p className={styles.desc}>{t('stepUp.description')}</p>

        {iamMode ? (
          iamPhase === 'verified' ? (
            <div className={styles.successState}>
              <span className={styles.successCheck}><CheckIcon /></span>
              <p className={styles.successText} role="status">{t('stepUp.iamSuccess')}</p>
            </div>
          ) : iamPhase === 'waiting' || iamPhase === 'polling' ? (
            <div className={styles.waitState}>
              <span className={styles.spinner} aria-hidden="true" />
              <p className={styles.waitText} role="status">
                {iamPhase === 'polling' ? t('stepUp.iamPolling') : t('stepUp.iamWaiting')}
              </p>
              {error && <p className={styles.error} role="alert">{error}</p>}
              <div className={styles.actions}>
                <button type="button" className={styles.btnGhost} onClick={onCancel}>{t('stepUp.cancel')}</button>
              </div>
            </div>
          ) : (
            <>
              <p className={styles.iamPrompt}>{t('stepUp.iamPrompt')}</p>
              {error && <p className={styles.error} role="alert">{error}</p>}
              <div className={styles.actions}>
                <button type="button" className={styles.btnGhost} onClick={onCancel} disabled={submitting}>
                  {t('stepUp.cancel')}
                </button>
                <button type="button" className={styles.btnPrimary} onClick={handleIamStepUp} disabled={submitting}>
                  {submitting ? t('stepUp.iamRedirecting') : t('stepUp.iamStart')}
                </button>
              </div>
            </>
          )
        ) : (
          <>
            {/* Method selector */}
            {availableMethods.length > 1 && (
              <Select
                label={t('stepUp.methodLabel')}
                value={selectedMethod}
                onChange={(v) => setSelectedMethod(v)}
                options={availableMethods.map((m) => ({ value: m, label: methodLabels[m] }))}
              />
            )}

            {selectedMethod === 'password' && (
              <input
                type="password"
                className={styles.input}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('stepUp.passwordPlaceholder')}
                autoFocus
              />
            )}

            {(selectedMethod === 'totp' || selectedMethod === 'recovery_code') && (
              <input
                type="text"
                inputMode={selectedMethod === 'totp' ? 'numeric' : 'text'}
                className={styles.input}
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder={selectedMethod === 'totp' ? t('stepUp.totpPlaceholder') : t('stepUp.recoveryCodePlaceholder')}
                maxLength={selectedMethod === 'totp' ? 6 : undefined}
                autoFocus
              />
            )}

            {selectedMethod === 'passkey' && (
              <div>
                <p className={styles.iamPrompt}>
                  {passkeyProcessing ? t('stepUp.passkeyPrompting') : t('stepUp.passkeyPrompt')}
                </p>
                {!passkeyProcessing && (
                  <button
                    type="button"
                    className={styles.btnPrimaryFull}
                    onClick={() => { setPasskeyProcessing(true); handlePasskey() }}
                    disabled={submitting}
                  >
                    {submitting ? t('stepUp.verifying') : t('stepUp.passkeyStart')}
                  </button>
                )}
              </div>
            )}

            {error && <p className={styles.error} role="alert">{error}</p>}

            <div className={styles.actions}>
              <button type="button" className={styles.btnGhost} onClick={onCancel} disabled={submitting}>
                {t('stepUp.cancel')}
              </button>
              {selectedMethod !== 'passkey' && (
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={handleSubmit}
                  disabled={submitting || !selectedMethod}
                >
                  {submitting ? t('stepUp.verifying') : t('stepUp.confirm')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
