import { useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { useFormatTs } from '@/utils/datetime'
import { focusIsOrphaned } from '@/components/admin/restoreFocus'
import {
  AdminButton,
  Alert,
  ButtonLink,
  Card,
  DescriptionList,
  EmptyState,
  ReasonPromptDialog,
  SectionLabel,
  Skeleton,
  StatusBadge,
  USER_STATUS_TONE,
  USER_STATUS_LABEL_KEYS,
  type DescriptionItem,
} from '@/components/admin'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import type { RowLinkState } from './listParams'
import { emitAdminChange, useAdminChange } from './changes'

/** i18n 里的字符串数组（规则说明）。 */
/** 后端接受封禁的账户状态（routes/admin.ts handleBanUnban；旧后端没给 ban 字段时的回退） */
const BANNABLE_STATUSES: readonly string[] = ['active', 'pending_verification', 'suspended']

/** 不能封禁的原因 → 说明文案 */
const BAN_BLOCKED_KEYS: Record<'self' | 'status' | 'last_admin', string> = {
  self: 'adminUsers.cannotBanSelf',
  status: 'adminUsers.cannotBanStatus',
  last_admin: 'adminUsers.cannotBanLastAdmin',
}

function ruleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

interface RoleEntry {
  id: string
  name: string
  grantedBy: string
  createdAt: number
  expiresAt: number | null
}

interface DetailedUser {
  id: string
  username: string
  displayName: string
  email: string | null
  emailVerified: boolean
  status: string
  createdAt: number
  lastLoginAt: number | null
  avatarUrl: string | null
  oauthAccounts: Array<{ provider: string; providerUsername: string; boundAt: number }>
  security: { hasPassword: boolean; totpEnabled: boolean; passkeyCount: number }
  roles: RoleEntry[]
  /** 封禁资格（后端 §7.2，只给有 user:ban 的人）：与封禁接口同一套前置条件 */
  ban?: { canBan: boolean; canUnban: boolean; reason: 'self' | 'status' | 'last_admin' | null } | null
}

/**
 * 用户详情（/admin/users/:id）。
 *
 * 路由按 :id 整页重挂，组件实例即一次详情会话（见 AdminContributionDetail 的说明）。
 * 封禁 / 解封后原地刷新，需要二次验证时交给 step-up 重放。
 */
export const AdminUserDetail = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { id = '' } = useParams()
  const location = useLocation()
  const { accessToken, permissions, user: currentUser } = useAuth()
  // 危险操作（封禁/解封）可能返回 STEP_UP_REQUIRED → 弹 step-up（IAM 账号走代理 2FA 跳转）。
  const { runWithStepUp, stepUpElement } = useStepUpAction(accessToken)

  const [backTo] = useState(() => {
    const from = (location.state as Partial<RowLinkState> | null)?.from
    return typeof from === 'string' ? from : '/admin/users'
  })

  const [detail, setDetail] = useState<DetailedUser | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  /** 打不开这位用户（首次加载失败，或操作成功后读不回新状态）：整页换成错误态。 */
  const [loadError, setLoadError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState('')
  /** 本页实例的身份：收到自己发出的变更广播时忽略。 */
  const [instance] = useState(() => ({}))

  /* 封禁/解封的进行中锁。除了避免重复写请求，更关键的是：useStepUpAction 只有
     一个 pendingActionRef，两次并发操作若都返回 STEP_UP_REQUIRED，后一次会覆盖
     前一次，前一次将永远不会被重放。 */
  const [actionSubmitting, setActionSubmitting] = useState(false)
  /** 锁的归属序号：step-up 交接、卸载后旧回调都按它判断能不能释放锁。 */
  const actionSeqRef = useRef(0)
  /* 详情拉取的竞态守卫，只有最新一次请求能写入。 */
  const detailSeq = useRef(0)
  /* 详情会话序号：只在卸载时自增。用户已经离开时，403 的 step-up 不再弹、错误不再写。 */
  const sessionSeq = useRef(0)
  const sameSession = (session: number) => sessionSeq.current === session

  /**
   * 拉取用户详情。拉取失败一律换成错误态：写成功后读不回新状态时不收起，
   * 等于把未知的旧状态和一排可用的按钮交给用户。
   */
  const fetchDetail = async () => {
    const seq = ++detailSeq.current
    setDetailLoading(true)
    try {
      const result = await get<DetailedUser>(`/admin/users/${encodeURIComponent(id)}`)
      if (seq !== detailSeq.current) return // 过期响应，丢弃
      if (result.ok) {
        setLoadError('')
        setDetail(result.data)
      } else {
        // 理由弹窗属于这位用户，详情换成错误态时一起收掉
        setBanDialogOpen(false)
        setDetail(null)
        setLoadError(result.error.message || t('adminUsers.loadError'))
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }

  useEffect(() => {
    const detailRef = detailSeq
    const session = sessionSeq
    const action = actionSeqRef
    // 拉取数据是 effect 对外部数据源的订阅；fetchDetail 首行的 setDetailLoading 属该模式的同步 setState
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDetail()
    return () => {
      detailRef.current++
      session.current++
      action.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 封禁 / 解封共用的流程：成功后原地重读，STEP_UP_REQUIRED 交给 step-up 重放。 */
  const runAction = async (path: 'ban' | 'unban', body: Record<string, unknown>) => {
    if (!detail || actionSubmitting) return
    const userId = detail.id
    const session = sessionSeq.current
    const mySeq = ++actionSeqRef.current
    setActionSubmitting(true)
    setDetailError('')
    let handedOff = false
    const attempt = async () => {
      const result = await post(`/admin/users/${encodeURIComponent(userId)}/${path}`, body)
      /* 写成功就广播（哪怕已经离开）：当前挂着的列表 / 同一位用户的详情要重读。 */
      if (result.ok) emitAdminChange({ kind: 'user', id: userId, source: instance })
      if (!sameSession(session)) return
      if (result.ok) {
        await fetchDetail()
      } else if (result.error.code === 'STEP_UP_REQUIRED') {
        handedOff = true
        runWithStepUp(attempt, () => {
          if (actionSeqRef.current === mySeq) setActionSubmitting(false)
        })
      } else {
        setDetailError(result.error.message)
      }
    }
    try {
      await attempt()
    } finally {
      if (!handedOff && actionSeqRef.current === mySeq) setActionSubmitting(false)
    }
  }

  const openBan = () => {
    setBanReason('')
    setBanError('')
    setDetailError('')
    setBanDialogOpen(true)
  }

  const submitBan = async () => {
    const reason = banReason.trim()
    // 封禁理由 1-500 字符（api.md §7.5 / 后端 admin.ts 校验一致）
    if (!reason || reason.length > 500) {
      setBanError(t('adminUsers.banReasonRequired'))
      return
    }
    if (actionSubmitting) return
    setBanDialogOpen(false)
    setBanError('')
    await runAction('ban', { reason })
  }

  useAdminChange((change) => {
    if (change.kind !== 'user' || change.id !== id || change.source === instance) return
    void fetchDetail()
  })

  /* 打不开 → 重试成功：错误态里的重试按钮被换掉，焦点会掉到 body；只在焦点确实没人认领时接回 main。 */
  const hasDetail = detail !== null
  useEffect(() => {
    if (hasDetail && focusIsOrphaned()) document.getElementById('admin-main')?.focus({ preventScroll: true })
  }, [hasDetail])

  useAdminPageHeader({
    title: detail?.displayName || t('adminUsers.detailTitle'),
    back: { to: backTo, label: t('adminUsers.backToList'), focusRow: id },
    badge: detail
      ? {
          tone: USER_STATUS_TONE[detail.status] ?? 'neutral',
          label: t(USER_STATUS_LABEL_KEYS[detail.status] ?? detail.status),
        }
      : undefined,
  })

  if (!detail && loadError) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={loadError}
          /* 返回入口在标题栏里，这里只给重试 */
          action={
            <AdminButton variant="primary" onClick={() => void fetchDetail()} loading={detailLoading}>
              {t('common.retry')}
            </AdminButton>
          }
        />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={shell.page} aria-busy="true">
        <Skeleton variant="card" />
      </div>
    )
  }

  const metaItems: DescriptionItem[] = [
    { term: t('adminUsers.username'), value: t('common.handle', { username: detail.username }) },
    {
      term: t('adminUsers.email'),
      value: (
        <span className={shell.inlineMeta}>
          {detail.email ?? '—'}
          <StatusBadge
            tone={detail.emailVerified ? 'green' : 'red'}
            label={t(detail.emailVerified ? 'adminUsers.emailVerified' : 'adminUsers.emailUnverified')}
            size="sm"
          />
        </span>
      ),
    },
    { term: t('adminUsers.createdAt'), value: formatTs(detail.createdAt) || '—' },
    { term: t('adminUsers.lastLogin'), value: formatTs(detail.lastLoginAt) || '—' },
  ]

  const securityItems: DescriptionItem[] = [
    {
      term: t('adminUsers.passwordLabel'),
      value: detail.security.hasPassword ? t('adminUsers.hasPassword') : t('adminUsers.noPassword'),
    },
    {
      term: t('adminUsers.totpLabel'),
      value: detail.security.totpEnabled ? t('adminUsers.totpEnabled') : t('adminUsers.totpDisabled'),
    },
    {
      term: t('adminUsers.passkeyLabel'),
      value: t('common.countWithUnit', { count: detail.security.passkeyCount, unit: t('adminUsers.passkeyUnit') }),
    },
  ]

  const canBan = hasPermission(permissions, PERMISSIONS.USER_BAN)
  /* 封禁资格以后端给出的为准（§7.2 ban，与封禁接口同一套前置条件：不能封禁自己、账户状态、
     不能封禁最后一名活动管理员）。三种情况分开：
       · 有资格对象 —— 按它显示；
       · 显式 null —— 后端认定请求者没有 user:ban（比如权限刚被撤，本页的 /me 还是旧的），两个按钮都不给；
       · 字段缺失（undefined）—— 旧后端，才按能在前端判断的部分推导。 */
  const isSelf = !!currentUser && currentUser.id === detail.id
  const banInfo = detail.ban
  const legacyBan = banInfo === undefined
  const showBan = legacyBan ? canBan && !isSelf && BANNABLE_STATUSES.includes(detail.status) : !!banInfo?.canBan
  const showUnban = legacyBan ? canBan && detail.status === 'banned' : !!banInfo?.canUnban
  const banBlockedReason: 'self' | 'status' | 'last_admin' | null = legacyBan
    ? canBan && isSelf
      ? 'self'
      : null
    : (banInfo?.reason ?? null)
  const canSeeContributions = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)

  return (
    <div className={shell.page}>
      <div className={shell.detailGrid}>
        <Card className={shell.detailInfo}>
          <DescriptionList items={metaItems} columns={1} />
        </Card>

        <div className={shell.detailMain}>
          <Card>
            <SectionLabel>{t('adminUsers.securityHeading')}</SectionLabel>
            <DescriptionList items={securityItems} columns={2} />
          </Card>

          {detail.oauthAccounts.length > 0 && (
            <Card>
              <SectionLabel>{t('adminUsers.oauthLabel')}</SectionLabel>
              <ul className={shell.history}>
                {detail.oauthAccounts.map((oa) => (
                  <li key={oa.provider} className={shell.historyItem}>
                    {t('adminUsers.oauthAccount', { provider: oa.provider, username: oa.providerUsername })}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <SectionLabel>{t('adminUsers.roles')}</SectionLabel>
            {detail.roles.length === 0 ? (
              <p className={shell.subtleNote}>{t('adminUsers.noRoles')}</p>
            ) : (
              <ul className={shell.history}>
                {detail.roles.map((r) => (
                  <li key={r.id} className={shell.historyItem}>
                    {t('adminUsers.roleWithExpiry', {
                      name: r.name,
                      expiry: r.expiresAt
                        ? t('adminUsers.expiresAt', { time: formatTs(r.expiresAt) })
                        : t('adminUsers.permanent'),
                    })}
                  </li>
                ))}
              </ul>
            )}
            {/* 授权统一迁移到 IAM：本平台不再人工授予/撤销角色（iam-admin-api.md §4.4） */}
            <p className={shell.subtleNoteSpaced}>{t('adminUsers.rolesManagedInIam')}</p>
          </Card>
        </div>

        <div className={shell.detailSide}>
          {(showBan || showUnban || banBlockedReason || canSeeContributions || detailError) && (
            <Card>
              <div className={shell.stackSm}>
                <h2 className={shell.sideHeading}>{t('adminUsers.actionsHeading')}</h2>
                {detailError && <Alert tone="error">{detailError}</Alert>}
                <div className={shell.actions}>
                  {canSeeContributions && (
                    <ButtonLink
                      variant="secondary"
                      to={`/admin/contributions?status=all&author=${encodeURIComponent(detail.id)}`}
                    >
                      {t('adminUsers.viewContributions')}
                    </ButtonLink>
                  )}
                  {/* 封禁/解封需 user:ban（仅 admin）；editor 仅有 user:read 时只读不可操作 */}
                  {showUnban && (
                    <AdminButton
                      variant="primary"
                      loading={actionSubmitting}
                      disabled={detailLoading}
                      onClick={() => void runAction('unban', { reason: t('adminUsers.adminUnban') })}
                    >
                      {t('adminUsers.unban')}
                    </AdminButton>
                  )}
                  {showBan && (
                    <AdminButton variant="danger" disabled={actionSubmitting || detailLoading} onClick={openBan}>
                      {t('adminUsers.ban')}
                    </AdminButton>
                  )}
                </div>
                {banBlockedReason && <p className={shell.subtleNote}>{t(BAN_BLOCKED_KEYS[banBlockedReason])}</p>}
                {/* 封禁 / 解封的真实后果（routes/admin.ts handleBanUnban），按当前状态给 */}
                {(showBan || showUnban) && (
                  <ul className={shell.ruleList} aria-label={t('adminRules.heading')}>
                    {ruleList(
                      t(detail.status === 'banned' ? 'adminRules.unban' : 'adminRules.ban', { returnObjects: true }),
                    ).map((rule) => (
                      <li key={rule}>{rule}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      <ReasonPromptDialog
        open={banDialogOpen}
        title={t('adminUsers.banTitle')}
        prompt={t('adminUsers.banReasonPrompt')}
        placeholder={t('adminUsers.banReasonPlaceholder')}
        value={banReason}
        onChange={setBanReason}
        onSubmit={submitBan}
        onCancel={() => {
          setBanDialogOpen(false)
          setBanError('')
        }}
        submitText={t('adminUsers.ban')}
        cancelText={t('admin.cancelReason')}
        maxLength={500}
        counterText={t('admin.ui.charCount', { n: banReason.length, max: 500 })}
        error={banError || undefined}
        variant="danger"
      />

      {stepUpElement}
    </div>
  )
}
