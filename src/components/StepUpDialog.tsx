import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { post, setAccessToken, getAccessToken } from '@/api/client'
import styles from './StepUpDialog.module.css'

interface StepUpDialogProps {
  onSuccess: () => void
  onCancel: () => void
  /** 用于 API 认证的 Bearer Token — api.md §1.12 要求 */
  accessToken: string
}

/** IAM 代理 2FA 的弹窗子状态：发起 → 等待弹窗 → 回查 → 成功。 */
type IamPhase = 'iam' | 'waiting' | 'polling' | 'verified'

// 回传信号到达时后端通常已标记验证（与整页回跳的单次回查一致）；少量重试容忍提交延迟。
const IAM_POLL_ATTEMPTS = 10
const IAM_POLL_INTERVAL_MS = 600
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const CheckIcon = () => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const StepUpDialog = ({ onSuccess, onCancel, accessToken }: StepUpDialogProps) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  // 所有账户（Pass / IAM）的二次验证均由统一身份代理完成（弹窗 verify_url，主窗口保持对话框打开）
  const [iamPhase, setIamPhase] = useState<IamPhase>('iam')
  const iamVerificationIdRef = useRef<string>('')
  const popupRef = useRef<Window | null>(null)
  // 防止「回传消息」与「弹窗关闭轮询」对同一次验证重复回查。
  const iamPolledRef = useRef(false)
  // 供按键处理闭包读取当前 IAM 阶段（闭包 deps 为 [onCancel]，不会响应式捕获 iamPhase）。
  const iamPhaseRef = useRef<IamPhase>('iam')
  // 成功后自动重放的定时器：卸载时需清理，避免在错误时机触发。
  const successTimerRef = useRef<number | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Sync accessToken into client memory so step-up API calls use correct auth.
  // Restore the original token on unmount via ref (不受 accessToken prop 变化影响)。
  const origTokenRef = useRef(getAccessToken())
  useEffect(() => {
    const tokenAtRender = origTokenRef.current
    if (accessToken) setAccessToken(accessToken)
    return () => setAccessToken(tokenAtRender)
  }, [accessToken])

  // Focus trap: trap focus inside dialog when open
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const restore = document.activeElement as HTMLElement | null
    // 实时查询可聚焦元素（切换 IAM 阶段后 DOM 会变化，不能用挂载时的快照），
    // 并过滤掉不可见（如移动端隐藏的折叠按钮）节点。
    const visibleFocusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
    visibleFocusables()[0]?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 验证成功 / 回查进行中不响应 Escape，避免打断自动重放导致已验证操作被丢弃
        if (iamPhaseRef.current === 'verified' || iamPhaseRef.current === 'polling') return
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = visibleFocusables()
      if (nodes.length === 0) {
        e.preventDefault()
        return
      }
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      if (e.shiftKey) {
        if (document.activeElement === first || !el.contains(document.activeElement)) {
          e.preventDefault()
          last.focus()
        }
      } else if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', handler)
    return () => {
      el.removeEventListener('keydown', handler)
      restore?.focus?.()
    }
  }, [onCancel])

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
          // 成功态展示片刻后自动重放原操作（无需二次确认）
          successTimerRef.current = window.setTimeout(() => onSuccess(), 900)
          return
        }
      } catch {
        // 忽略本次异常，继续重试
      }
      await new Promise((resolve) => window.setTimeout(resolve, IAM_POLL_INTERVAL_MS))
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
  useEffect(() => {
    iamPhaseRef.current = iamPhase
  }, [iamPhase])

  // 对话框卸载时关闭可能仍开着的弹窗，并清理成功重放定时器
  useEffect(
    () => () => {
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close()
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current)
    },
    [],
  )

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

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="stepup-title" className={styles.overlay}>
      <div className={styles.panel}>
        <h3 id="stepup-title" className={styles.title}>
          {t('stepUp.title')}
        </h3>
        <p className={styles.desc}>{t('stepUp.description')}</p>

        {iamPhase === 'verified' ? (
          <div className={styles.successState}>
            <span className={styles.successCheck}>
              <CheckIcon />
            </span>
            <p className={styles.successText} role="status">
              {t('stepUp.iamSuccess')}
            </p>
          </div>
        ) : iamPhase === 'waiting' || iamPhase === 'polling' ? (
          <div className={styles.waitState}>
            <span className={styles.spinner} aria-hidden="true" />
            <p className={styles.waitText} role="status">
              {iamPhase === 'polling' ? t('stepUp.iamPolling') : t('stepUp.iamWaiting')}
            </p>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.btnGhost} onClick={onCancel}>
                {t('stepUp.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className={styles.iamPrompt}>{t('stepUp.iamPrompt')}</p>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.btnGhost} onClick={onCancel} disabled={submitting}>
                {t('stepUp.cancel')}
              </button>
              <button type="button" className={styles.btnPrimary} onClick={handleIamStepUp} disabled={submitting}>
                {submitting ? t('stepUp.iamRedirecting') : t('stepUp.iamStart')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
