import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { post, setAccessToken, getAccessToken } from '@/api/client'
import styles from './StepUpDialog.module.css'
import { pushModalLayer, popModalLayer, isTopModalLayer } from '@/components/admin/modalStack'
import { lockScroll, unlockScroll } from '@/components/admin/scrollLock'
import { restoreFocus } from '@/components/admin/restoreFocus'

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
/* 单次回查的超时。回查阶段既屏蔽 Escape 也禁用取消按钮（那时后端很可能已经
   确认了验证，中断会把已通过的操作丢掉），代价是一旦某次请求悬着不返回，整个
   对话框就再也退不出去，用户只能刷新页面。给每次请求一个上限，让循环一定能往
   前走、最终回到可操作的发起态。 */
const IAM_POLL_TIMEOUT_MS = 8000
/* 整轮回查的时间上限。单次超时只保证「这一次」能结束，10 次连着超时仍要一分多钟，
   那段时间里对话框依旧退不出去。用总预算兜住最坏情况。 */
const IAM_POLL_BUDGET_MS = 20000
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
  /* 本轮 step-up 是否仍然有效。取消或卸载后置为 false。
     回查是一个跨多次 await 的循环，取消并不会中断它；若不设这道闸，
     一次「取消后仍然成功」的旧回查会调用 onSuccess，而 onSuccess 读的是
     hook 里**当前**的 pendingActionRef——用户随后发起的另一个操作会被
     它直接重放并关掉刚弹出的验证框。 */
  const aliveRef = useRef(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  /* 只在 client 内存里**没有** token 时才补写。
     client 的那一份才是权威的：401 自动刷新只更新 client 内存，AuthContext 里
     这一份可能已经是过期的旧 token。无条件写回等于把刚续期的凭证作废，还会
     因身份变更而递增认证代号、连带作废在途的 refresh，并发请求会拿到原始 401。 */
  useEffect(() => {
    if (!accessToken) return
    if (getAccessToken() !== null) return
    setAccessToken(accessToken)
    return () => {
      if (getAccessToken() === accessToken) setAccessToken(null)
    }
  }, [accessToken])

  // Focus trap: trap focus inside dialog when open
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    /* 加入 Modal 的浮层栈：本对话框常常开在 ReasonPromptDialog 之上，
       不入栈的话底层 Modal 的捕获阶段监听会抢走 Esc 并把自己关掉。 */
    const layerId = pushModalLayer('step-up')
    const restore = document.activeElement as HTMLElement | null
    // 实时查询可聚焦元素（切换 IAM 阶段后 DOM 会变化，不能用挂载时的快照），
    // 并过滤掉不可见（如移动端隐藏的折叠按钮）节点。
    const visibleFocusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
    visibleFocusables()[0]?.focus()

    /* 监听挂在 document 的捕获阶段，而不是对话框元素上——和 Modal 保持一致。
       挂在元素上只有「焦点恰好在对话框内」时才收得到按键：IAM 子窗口打开再关闭后，
       主窗口的焦点常常落回 body，那时 Esc 取消不了、Tab 还能走进背景内容
       （底层 Modal 的监听又会因为自己不是栈顶而直接返回，没人接手）。
       用 isTopModalLayer 保证只有最上面一层处理按键。 */
    const handler = (e: KeyboardEvent) => {
      if (!isTopModalLayer(layerId)) return
      if (e.key === 'Escape') {
        // 验证成功 / 回查进行中不响应 Escape，避免打断自动重放导致已验证操作被丢弃
        if (iamPhaseRef.current === 'verified' || iamPhaseRef.current === 'polling') return
        e.stopPropagation()
        aliveRef.current = false
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = visibleFocusables()
      if (nodes.length === 0) {
        e.preventDefault()
        // 一个可聚焦元素都没有（成功态）时兜底聚焦对话框本身。
        // 焦点停在内部某个已禁用控件上时同样要挪，不能只判「在对话框外」。
        if (document.activeElement !== el) el.focus()
        return
      }
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      // 焦点已经在对话框外（子窗口关闭后常落回 body）：直接拉回来
      if (!el.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      /* 焦点停在对话框本身（上一轮「全禁用」时的兜底落点）：它既不是第一个也不是
         最后一个控件，不接管的话浏览器会按文档顺序把焦点送出对话框。 */
      if (document.activeElement === el) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => {
      document.removeEventListener('keydown', handler, true)
      popModalLayer(layerId)
      /* 焦点还原推迟一帧：出栈会让底层 Modal 重新变回栈顶，而它的 inert 要等
         React 提交下一次渲染才摘掉。在那之前对着 inert 里的元素调 focus()
         是静默失败的，焦点会掉到 body 上。 */
      requestAnimationFrame(() => {
        /* 这一帧的间隙里可能又弹出了新的浮层并自行聚焦（取消后立刻再次触发
           需要 step-up 的操作就会这样）。此时还原焦点会把它从新弹窗里抢走，
           落到旧触发按钮或 <main> 上。只有没人认领焦点时才还原。 */
        const active = document.activeElement
        if (active && active !== document.body && active !== document.documentElement) return
        restoreFocus(restore)
      })
    }
  }, [onCancel])

  // ── IAM 代理 2FA：弹窗流程（避免整页跳转丢失发起页状态）──────

  // 后端权威回查（主窗口持有有效 access token；弹窗仅负责回传信号后自行关闭）
  const pollIamResult = async (afterPopupClose = false) => {
    if (iamPolledRef.current || !aliveRef.current) return
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
    const deadline = Date.now() + IAM_POLL_BUDGET_MS
    for (let attempt = 0; attempt < IAM_POLL_ATTEMPTS; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), IAM_POLL_TIMEOUT_MS)
        let result: Awaited<ReturnType<typeof post<{ verified?: boolean }>>>
        try {
          result = await post<{ verified?: boolean }>(
            '/auth/step-up/iam/poll',
            { verificationId: vid },
            { signal: controller.signal },
          )
        } finally {
          window.clearTimeout(timeout)
        }
        // 取消/卸载发生在这次 await 期间：本轮已作废，不得再驱动界面
        if (!aliveRef.current) return
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
      if (!aliveRef.current) return
      if (Date.now() > deadline) break
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

  /* 阶段切换会换掉整块操作区（「开始验证」按钮在进入 waiting 时被卸载）。
     焦点原本停在被卸载的按钮上，此后会落回 body——焦点陷阱监听挂在对话框
     元素上，焦点一旦跑到对话框外，Tab 就不再经过它，用户会直接 Tab 到背景
     内容里去。因此每次换阶段都把焦点交还给本阶段的第一个可见控件。 */
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (el.contains(document.activeElement)) return
    const next = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
      (n) => n.offsetParent !== null,
    )
    // 成功态没有任何按钮，此时退而聚焦对话框本身（tabIndex=-1）：
    // 按键监听挂在这个节点上，焦点留在它里面 Tab 才会被拦下。
    if (next) next.focus()
    else el.focus()
  }, [iamPhase])

  // 挂载期间锁住 body 滚动（遮罩是 fixed 的，不锁则背景仍可滚）；
  // 卸载时作废本轮回查、关闭可能仍开着的弹窗、清理成功重放定时器。
  useEffect(() => {
    // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，
    // 而 ref 在同一实例上不会重建——不在这里置回 true，回查会被永久关死。
    aliveRef.current = true
    lockScroll()
    return () => {
      aliveRef.current = false
      unlockScroll()
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close()
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current)
    }
  }, [])

  /* 取消：先作废本轮，再交回上层。不能只依赖卸载 cleanup——那是异步的，
     而 onCancel 之后用户可以立刻发起下一个需要 step-up 的操作。 */
  const handleCancel = () => {
    aliveRef.current = false
    onCancel()
  }

  const handleIamStepUp = async () => {
    setSubmitting(true)
    setError('')
    iamPolledRef.current = false

    /* 必须在点击处理器里**同步**把窗口开出来。瞬态用户激活只持续几秒，等
       /auth/step-up/iam/start 返回再 open 的话，网络稍慢就会被拦截器挡下，
       稳定退化成整页跳转——而整页跳转会销毁待重放的操作，用户验证完还得回来
       重做一遍。先开一个空白窗口占住这次激活，拿到地址后再给它导航。 */
    const popup = window.open('', 'tc-iam-stepup', 'width=480,height=720,menubar=no,toolbar=no,location=yes')

    const result = await post<{ verifyUrl?: string; verificationId?: string }>('/auth/step-up/iam/start', {})
    /* 发起期间对话框可能已被 Esc 关掉（取消按钮此时是禁用的，Esc 不是）。
       本轮既已作废，就不能再写 sessionStorage、更不能留下一个没人回查的验证窗口。 */
    if (!aliveRef.current) {
      popup?.close()
      return
    }
    if (!result.ok || !result.data.verifyUrl || !result.data.verificationId) {
      popup?.close()
      setError(t('stepUp.iamStartError'))
      setSubmitting(false)
      return
    }
    iamVerificationIdRef.current = result.data.verificationId
    /* 兜底：弹窗被拦截时退回整页跳转，沿用 StepUpDone 的回查逻辑。
       setItem 可能抛错（隐私模式、配额耗尽）——不能让它把整个流程带走：抛出去的话
       下面的解锁永远执行不到，两个按钮一起卡在 disabled，鼠标用户连取消都点不了。
       写失败只意味着「整页兜底那条路走不通」，弹窗模式本身照常。 */
    let storageOk = true
    try {
      sessionStorage.setItem('iamStepUpVerificationId', result.data.verificationId)
      sessionStorage.setItem('iamStepUpReturnTo', window.location.pathname + window.location.search)
    } catch {
      storageOk = false
    }
    if (!popup || popup.closed) {
      /* 弹窗被拦截 → 退回整页跳转。但这条路完全建立在刚才那两个 sessionStorage
         上：回跳落地页要靠 verificationId 去回查、靠 returnTo 回到发起页。写失败
         的话跳过去也是白跳——轻则回到 /admin 而不是原页面，重则直接显示验证失败。
         与其把用户送进一条注定走不通的路，不如就地说清楚。 */
      if (!storageOk) {
        setError(t('stepUp.popupBlocked'))
        setSubmitting(false)
        return
      }
      window.location.href = result.data.verifyUrl
      return
    }
    popup.location.href = result.data.verifyUrl
    popupRef.current = popup
    setSubmitting(false)
    setIamPhase('waiting')
  }

  /* 必须和 Modal 一样 portal 到 body：本对话框常常开在理由/确认弹窗之上，
     而那些弹窗是 body 的后置子节点。留在 app root 里渲染的话，即便 z-index
     相同，后绘制的理由弹窗遮罩也会盖在上面并吃掉所有点击——键盘栈解决不了
     绘制顺序和指针事件。z-index 同时抬到 Modal 之上（见 .module.css）。 */
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      tabIndex={-1}
      className={styles.overlay}
    >
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
              {/* 回查阶段不能取消：后端很可能已经确认了这次二次验证，此时取消会清掉
                  待重放的操作——用户明明验证通过了，管理动作却不声不响地没执行。
                  与 Escape 的处理保持一致（那里同样屏蔽 polling / verified）。 */}
              <button
                type="button"
                className={styles.btnGhost}
                onClick={handleCancel}
                disabled={iamPhase === 'polling'}
              >
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
              <button type="button" className={styles.btnGhost} onClick={handleCancel} disabled={submitting}>
                {t('stepUp.cancel')}
              </button>
              <button type="button" className={styles.btnPrimary} onClick={handleIamStepUp} disabled={submitting}>
                {submitting ? t('stepUp.iamRedirecting') : t('stepUp.iamStart')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
