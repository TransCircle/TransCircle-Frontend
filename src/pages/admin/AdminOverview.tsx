import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { AdminButton, Alert, Card, SectionLabel, Skeleton, StatusBadge, CONTRIB_STATUS_TONE } from '@/components/admin'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import { ANY_STATUS_LABEL_KEYS } from './contributions'
import { useAdminChange } from './changes'
import { MyPermissions } from './MyPermissions'

/** GET /admin/contributions/stats（apidocs §6.8）。 */
interface ContributionStats {
  totals: {
    draft: number
    pending: number
    inReview: number
    approved: number
    rejected: number
    published: number
    hidden: number
    withdrawn: number
    deleted: number
  }
  submissions: { today: number; last7Days: number; last30Days: number }
  averageReviewLatencySeconds: number
}

/* 状态分布的行：接口字段 → 状态枚举 → 投稿管理里能不能直接筛出来。
   草稿、已撤回不在后台列表的筛选项里（作者自己的东西），只计数不链接；
   已删除的投稿后台列表本就不返回，也不链接。 */
const BREAKDOWN: Array<{ field: keyof ContributionStats['totals']; status: string; link: boolean }> = [
  { field: 'pending', status: 'pending', link: true },
  { field: 'inReview', status: 'in_review', link: true },
  { field: 'approved', status: 'approved', link: true },
  { field: 'published', status: 'published', link: true },
  { field: 'hidden', status: 'hidden', link: true },
  { field: 'rejected', status: 'rejected', link: true },
  { field: 'draft', status: 'draft', link: false },
  { field: 'withdrawn', status: 'withdrawn', link: false },
  { field: 'deleted', status: 'deleted', link: false },
]

/**
 * 概览：内容审核的当前状态 + 自己的角色与权限。
 *
 * 同 Pass 控制台的原则：不画图表——这个体量画比例条是数据浮夸；导航不带角标，
 * 「有多少」的问题都收敛到这一页回答。每个数字都通向能处理它的那个列表。
 *
 * 持有任一后台权限即可打开；每一块按它背后接口的权限显示（与后端 requirePermission 对齐），
 * 没有权限的块不请求、不渲染：
 *   · 投稿统计、状态分布、处理流程 —— contribution:read（GET /admin/contributions/stats）；
 *   · 待投票修改申请 —— contribution:edit-request:vote（GET /admin/edit-requests）；
 *   · 我的角色 / 我的权限 —— 所有人（数据来自 /me，不请求后台接口）。
 */
export const AdminOverview = () => {
  const { t } = useTranslation()
  const { user, permissions } = useAuth()
  const canReadContributions = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  const canVote = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE)

  const [stats, setStats] = useState<ContributionStats | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(canReadContributions || canVote)
  /* 待投票的修改申请数：统计接口不含它，借列表接口的 pagination.total（limit=1），不需要新接口。
     null = 没权限或没取到——这块就不显示，不报错（它只是附带信息）。 */
  const [pendingEdits, setPendingEdits] = useState<number | null>(null)
  /* 修改申请的通过 / 驳回票数门槛：取接口回传的 votes.required（后端常量），不在前端写死；
     没有申请可读时说明里不写具体数字。 */
  const [requiredVotes, setRequiredVotes] = useState<number | null>(null)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    const [statsResult, editsResult] = await Promise.all([
      canReadContributions ? get<ContributionStats>('/admin/contributions/stats') : Promise.resolve(null),
      canVote
        ? get<Array<{ votes?: { required?: number } }>>('/admin/edit-requests?limit=1&page=1&status=pending,in_review')
        : Promise.resolve(null),
    ])
    if (seq !== seqRef.current) return
    if (statsResult) {
      if (statsResult.ok) setStats(statsResult.data)
      else setError(statsResult.error.message || t('adminOverview.loadError'))
    }
    setPendingEdits(editsResult && editsResult.ok ? (editsResult.pagination?.total ?? editsResult.data.length) : null)
    const required = editsResult && editsResult.ok ? editsResult.data[0]?.votes?.required : undefined
    if (typeof required === 'number') setRequiredVotes(required)
    setLoading(false)
  }, [canReadContributions, canVote, t])

  useEffect(() => {
    // 一个后台接口都没权限（只看自己的权限表）：什么都不请求
    if (!canReadContributions && !canVote) return
    // 拉取数据是 effect 对外部数据源的订阅
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const seq = seqRef
    return () => {
      seq.current++
    }
  }, [load, canReadContributions, canVote])

  // 别处（详情页）写成功了：数量变了，重取统计（请求序号守卫处理重叠）
  useAdminChange((change) => {
    if (!canReadContributions && !canVote) return
    if (change.kind === 'contribution' || change.kind === 'editRequest') void load()
  })

  useAdminPageHeader({
    title: t('adminOverview.title'),
    // 没有投稿统计可看的人，这一页只剩自己的角色与权限
    subtitle: canReadContributions ? t('adminOverview.subtitle') : t('adminOverview.subtitleSelf'),
  })

  const editsKpi =
    pendingEdits !== null ? (
      <Link to="/admin/edit-requests" className={`${shell.kpi} ${shell.kpiLink}`}>
        <span className={shell.kpiLabel}>{t('adminOverview.kpiEdits')}</span>
        <span className={shell.kpiValue}>{pendingEdits}</span>
        <span className={shell.kpiSub}>{t('adminOverview.kpiEditsSub')}</span>
      </Link>
    ) : null

  const mine = <MyPermissions roles={user?.roles ?? []} permissions={permissions} />

  /* 没有投稿读取权限：不请求统计，只给修改申请（有投票权限时）与自己的权限 */
  if (!canReadContributions) {
    return (
      <div className={shell.page}>
        {editsKpi && <div className={shell.kpis}>{editsKpi}</div>}
        {mine}
      </div>
    )
  }

  if (!stats) {
    return (
      <div className={shell.page}>
        {error ? (
          <Alert tone="error">
            <span className={shell.errorRow}>
              {error}
              <AdminButton variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
                {t('common.retry')}
              </AdminButton>
            </span>
          </Alert>
        ) : (
          <div aria-busy="true">
            <span className={shell.srOnly} role="status">
              {t('common.loading')}
            </span>
            <Skeleton variant="card" />
          </div>
        )}
        {mine}
      </div>
    )
  }

  /* 「待处理」只数审核队列真正装着的待审核；历史遗留的「审核中」（当前后端不再产生）单独提示，链到投稿管理。 */
  const waiting = stats.totals.pending
  const latency = formatLatency(stats.averageReviewLatencySeconds)
  const grandTotal = BREAKDOWN.reduce((sum, row) => sum + (stats.totals[row.field] ?? 0), 0)

  return (
    <div className={shell.page}>
      {error && <Alert tone="error">{error}</Alert>}

      <div className={shell.kpis}>
        <Link to="/admin/review" className={`${shell.kpi} ${shell.kpiLink}`}>
          <span className={shell.kpiLabel}>{t('adminOverview.kpiWaiting')}</span>
          <span className={shell.kpiValue}>{waiting}</span>
          <span className={shell.kpiSub}>
            {stats.totals.inReview > 0
              ? t('adminOverview.kpiWaitingSubLegacy', { count: stats.totals.inReview })
              : t('adminOverview.kpiWaitingSub')}
          </span>
        </Link>
        <div className={shell.kpi}>
          <span className={shell.kpiLabel}>{t('adminOverview.kpiToday')}</span>
          <span className={shell.kpiValue}>{stats.submissions.today}</span>
          <span className={shell.kpiSub}>
            {t('adminOverview.kpiTodaySub', { week: stats.submissions.last7Days, month: stats.submissions.last30Days })}
          </span>
        </div>
        <div className={shell.kpi}>
          <span className={shell.kpiLabel}>{t('adminOverview.kpiLatency')}</span>
          <span className={shell.kpiValue}>
            {latency ? (
              <>
                {latency.value}
                <span className={shell.kpiUnit}>{t(latency.unitKey)}</span>
              </>
            ) : (
              '—'
            )}
          </span>
          <span className={shell.kpiSub}>{t('adminOverview.kpiLatencySub')}</span>
        </div>
        {editsKpi}
      </div>

      <Card>
        <SectionLabel>{t('adminOverview.breakdownTitle')}</SectionLabel>
        <ul className={shell.breakdown}>
          {BREAKDOWN.map((row) => {
            const count = stats.totals[row.field] ?? 0
            const badge = (
              <StatusBadge
                tone={CONTRIB_STATUS_TONE[row.status] ?? 'neutral'}
                label={t(ANY_STATUS_LABEL_KEYS[row.status] ?? row.status)}
                size="sm"
              />
            )
            return (
              <li key={row.field}>
                {row.link ? (
                  <Link
                    to={row.status === 'pending' ? '/admin/review' : `/admin/contributions?status=${row.status}`}
                    className={`${shell.breakdownRow} ${shell.breakdownLink}`}
                  >
                    {badge}
                    <span className={shell.breakdownNum}>{count}</span>
                  </Link>
                ) : (
                  <span className={shell.breakdownRow}>
                    {badge}
                    <span className={shell.breakdownNum}>{count}</span>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <p className={shell.subtleNoteSpaced}>{t('adminOverview.breakdownTotal', { count: grandTotal })}</p>
      </Card>

      {/* 处理流程：把后端的状态机与门槛摆出来（routes/admin.ts、me.ts、contributions.ts），
          审核员不用去猜「点了通过之后会怎样」「修改申请要几票」。 */}
      <Card>
        <SectionLabel>{t('adminOverview.flowTitle')}</SectionLabel>
        <ol className={shell.flowList}>
          {ruleList(t('adminOverview.flowSteps', { returnObjects: true })).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {/* 修改申请的规则只给能处理修改申请（投票）的人 */}
        {canVote && (
          <p className={shell.subtleNoteSpaced}>
            {requiredVotes !== null
              ? t('adminOverview.flowEdits', { required: requiredVotes })
              : t('adminOverview.flowEditsNoCount')}
          </p>
        )}
      </Card>

      {mine}
    </div>
  )
}

/** i18n 里的字符串数组（规则说明）。 */
function ruleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

/** 平均审核耗时：秒 → 最合适的一个单位。0 / 无数据时返回 null（显示破折号）。 */
function formatLatency(seconds: number): { value: string; unitKey: string } | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 3600)
    return { value: String(Math.max(1, Math.round(seconds / 60))), unitKey: 'adminOverview.unitMinutes' }
  if (seconds < 48 * 3600)
    return { value: (seconds / 3600).toFixed(1).replace(/\.0$/, ''), unitKey: 'adminOverview.unitHours' }
  return { value: (seconds / 86400).toFixed(1).replace(/\.0$/, ''), unitKey: 'adminOverview.unitDays' }
}
