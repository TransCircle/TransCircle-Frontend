import { useState, useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { ellipsize } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import { AdminButton, Alert, EmptyState, Pill, SearchField, Skeleton } from '@/components/admin'
import { Pagination, Select } from '@/components/ui'
import shell from './Page.module.css'
import { useAdminPageHeader } from './admin/header'
import { useListParams } from './admin/listParams'

const PAGE_SIZE = 50

interface AuditLogEntry {
  id: string
  actorUserId: string | null
  /** 操作者（后端 §8 解析好的显示名）；系统操作为 null */
  actor?: { id: string; displayName: string | null } | null
  action: string
  resourceType: string
  resourceId: string | null
  /** 操作对象；label 是可读名称，按读者权限下发（无权或已不存在时为 null） */
  resource?: { type: string; id: string | null; label: string | null; deleted?: boolean }
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  createdAt: number
  requestId: string
  // 后端审计列表不返回 metadata / ipHash（api.md §8）；如未来返回再设为可选字段
}

/** 审计里出现的对象类型（后端 writeAuditLog 的 resourceType），与筛选下拉、类型标记共用 */
const RESOURCE_TYPES = ['contribution', 'user', 'comment', 'session', 'image'] as const
const RESOURCE_TYPE_KEYS: Record<string, string> = {
  contribution: 'adminAuditLogs.typeContribution',
  user: 'adminAuditLogs.typeUser',
  comment: 'adminAuditLogs.typeComment',
  session: 'adminAuditLogs.typeSession',
  image: 'adminAuditLogs.typeImage',
}

export const AdminAuditLogs = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  /* 已应用的筛选在 URL 里（?action=&resource=&page=）；输入框只是草稿，回车 / 点搜索才写进 URL。
     输入框的值直接进请求的话，改了筛选但没点搜索就翻页，会查成「新筛选 + 旧页码」。 */
  const { searchParams, patch, page: urlPage, setPage } = useListParams()
  const appliedAction = (searchParams.get('action') ?? '').trim()
  const appliedResource = (searchParams.get('resource') ?? '').trim()
  const [actionFilter, setActionFilter] = useState(appliedAction)
  const ready = !authLoading && !!accessToken && hasPermission(permissions, PERMISSIONS.AUDIT_READ)

  /* 已应用的筛选被外部改了（后退、外链）而不是本页刚写的：回填输入框。
     对象类型是下拉，直接读 URL，不需要草稿。 */
  const lastAppliedRef = useRef({ action: appliedAction, resource: appliedResource })
  useEffect(() => {
    const last = lastAppliedRef.current
    if (last.action === appliedAction && last.resource === appliedResource) return
    lastAppliedRef.current = { action: appliedAction, resource: appliedResource }
    setActionFilter(appliedAction)
  }, [appliedAction, appliedResource])
  const actionLabel = (action: string): string => t(`adminAuditLogs.actions.${action.replace(/\./g, '_')}`, action)

  // 游标分页列表（统一模板）：筛选由 onSearch 显式触发 reload
  const {
    items: logs,
    page,
    total,
    totalPages,
    stale,
    staleResults,
    loading,
    error,
    refresh,
  } = usePagedList<AuditLogEntry>({
    fetchPage: async (targetPage) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
      if (appliedAction) params.set('action', appliedAction)
      if (appliedResource) params.set('resourceType', appliedResource)
      const result = await get<AuditLogEntry[]>(`/admin/audit-logs?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (!result.ok) throw new Error(result.error.message)
      return toPagedResult(result.data, result.pagination)
    },
    // 无 audit:read 时不发起（守卫已显示拒绝页），免发无谓 403
    deps: [ready, appliedAction, appliedResource],
    autoLoad: ready,
    page: urlPage,
    // 越界页被服务端回落时，把实际页码写回 URL
    onPageMismatch: setPage,
  })
  useAdminPageHeader({ title: t('adminAuditLogs.title'), subtitle: t('adminAuditLogs.subtitle') })
  const canOpenUsers = hasPermission(permissions, PERMISSIONS.USER_READ)
  const canOpenContributions = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  const canOpenComments = hasPermission(permissions, PERMISSIONS.COMMENT_MODERATE)

  const applyFilters = (action: string, resource: string) => {
    // 条件没变（如加载失败后再点一次搜索）：URL 不会变，直接重取
    if (action === appliedAction && resource === appliedResource) {
      void refresh()
      return
    }
    lastAppliedRef.current = { action, resource }
    patch({ action: action || null, resource: resource || null })
  }

  const searchLogs = () => applyFilters(actionFilter.trim(), appliedResource)

  /* 清除按钮必须同步「已应用」的筛选并重载，理由同 AdminUsers。 */
  const clearAction = () => applyFilters('', appliedResource)
  /* 对象类型是下拉：选了就生效；操作类型框里还没点搜索的草稿一并带上，免得界面显示的和实际查的不一致 */
  const changeResource = (resource: string) => applyFilters(actionFilter.trim(), resource)

  /** 审计记录指向的资源在后台有详情页、且有权限打开时，对象名称变成链接。 */
  const resourceHref = (type: string, id: string): string | null => {
    if (type === 'contribution' && canOpenContributions) return `/admin/contributions/${encodeURIComponent(id)}`
    if (type === 'user' && canOpenUsers) return `/admin/users/${encodeURIComponent(id)}`
    if (type === 'comment' && canOpenComments) return `/admin/comments/${encodeURIComponent(id)}`
    return null
  }

  /* 操作者：显示名（后端解析）；有 user:read 时可点去用户详情。旧后端没给名字时退回短 ID。 */
  const renderActor = (log: AuditLogEntry): ReactNode => {
    const id = log.actor?.id ?? log.actorUserId
    if (!id) return <span className={shell.auditMuted}>{t('adminAuditLogs.actorSystem')}</span>
    const name = log.actor?.displayName || null
    const text = name ?? <span className={shell.auditId}>{ellipsize(id, 12)}</span>
    return canOpenUsers ? (
      <Link to={`/admin/users/${encodeURIComponent(id)}`} className={shell.textLink}>
        {text}
      </Link>
    ) : (
      text
    )
  }

  /* 操作对象：类型标记 + 可读名称（投稿标题 / 用户显示名 / 评论摘要）。没有名称时
     （无权查看、对象已不存在、会话与图片这类本就没有名称的）只给类型和短 ID，不把长 ID 当名字摆出来。 */
  const renderResource = (log: AuditLogEntry): ReactNode => {
    const type = log.resource?.type ?? log.resourceType
    const id = log.resource?.id ?? log.resourceId
    const label = log.resource?.label || null
    const deleted = !!log.resource?.deleted
    // 已删除的投稿后台详情打不开（详情只查未删除的）：不给链接，标出已删除；评论详情能打开已删除的评论（看举报与处理记录）
    const href = id && (!deleted || type === 'comment') ? resourceHref(type, id) : null
    // 截断样式直接加在链接上（加在里层 inline-block 上会吃掉链接的下划线）
    const text = label ?? (id ? ellipsize(id, 16) : null)
    const textClass = label ? shell.auditLabel : shell.auditId
    return (
      <>
        <Pill>{RESOURCE_TYPE_KEYS[type] ? t(RESOURCE_TYPE_KEYS[type]) : type}</Pill>
        {text &&
          (href ? (
            <Link to={href} className={`${shell.textLink} ${textClass}`} title={label ?? id ?? undefined}>
              {text}
            </Link>
          ) : (
            <span className={textClass} title={label ?? id ?? undefined}>
              {text}
            </span>
          ))}
        {deleted && <span className={shell.auditMuted}>{t('adminAuditLogs.deleted')}</span>}
      </>
    )
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <SearchField
            value={actionFilter}
            onValueChange={setActionFilter}
            onSearch={searchLogs}
            onClear={clearAction}
            placeholder={t('adminAuditLogs.filterAction')}
            searchAriaLabel={t('adminAuditLogs.filterAction')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          {/* 按钮只提交左边的关键词（类型下拉一改就生效），所以紧挨着搜索框；窄屏时下拉换到第二行 */}
          <AdminButton variant="secondary" onClick={searchLogs}>
            {t('adminAuditLogs.search')}
          </AdminButton>
          <Select<string>
            value={appliedResource}
            onChange={changeResource}
            ariaLabel={t('adminAuditLogs.filterResource')}
            fieldClassName={shell.auditTypeSelect}
            options={[
              { value: '', label: t('adminAuditLogs.typeAll') },
              ...RESOURCE_TYPES.map((type) => ({ value: type, label: t(RESOURCE_TYPE_KEYS[type] ?? type) })),
            ]}
          />
        </div>
      </div>

      {error && (
        <Alert tone="error">
          <span className={shell.errorRow}>
            {error}
            <AdminButton variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
              {t('common.retry')}
            </AdminButton>
          </span>
        </Alert>
      )}

      {loading && logs.length === 0 ? (
        <Skeleton rows={8} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
         对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
      staleResults ? (
        // 已确认不属于当前条件的旧行不再摆出来；重试在途时只给加载提示
        loading ? (
          <div className={shell.loadingBar} role="status" aria-live="polite">
            {t('adminAuditLogs.loading')}
          </div>
        ) : null
      ) : logs.length === 0 ? (
        <EmptyState title={t('adminAuditLogs.empty')} />
      ) : (
        <>
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminAuditLogs.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {logs.map((log) => (
              <li key={log.id} className={shell.auditRow}>
                <div className={shell.auditMain}>
                  <span className={shell.rowTitle}>{actionLabel(log.action)}</span>
                  {/* 操作者与操作对象是两个带标签的字段，不用圆点串成一行 */}
                  <dl className={shell.metaFields}>
                    <div className={shell.metaField}>
                      <dt>{t('adminAuditLogs.actorLabel')}</dt>
                      <dd>{renderActor(log)}</dd>
                    </div>
                    <div className={shell.metaField}>
                      <dt>{t('adminAuditLogs.resourceLabel')}</dt>
                      <dd>{renderResource(log)}</dd>
                    </div>
                  </dl>
                </div>
                <div className={shell.auditSide}>
                  <time dateTime={new Date(log.createdAt).toISOString()}>{formatTs(log.createdAt)}</time>
                  {/* 操作类型的原始代码：上面「操作类型」筛选按它查 */}
                  <code className={shell.auditCode}>{log.action}</code>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
          （并发删除、状态变更、游标过期），读者仍需要能退回上一页。
          控件本身在只有一页时会自行隐藏。 */}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        disabled={loading || stale}
        onChange={setPage}
      />
    </div>
  )
}
