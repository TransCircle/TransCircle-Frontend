import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList } from '@/hooks/usePagedList'
import { limitByUnicode } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import { AdminButton, Alert, EmptyState, Pill, SearchField, Skeleton } from '@/components/admin'
import { Pagination } from '@/components/ui'
import shell from './Page.module.css'

interface AuditLogEntry {
  id: string
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  createdAt: number
  requestId: string
  // 后端审计列表不返回 metadata / ipHash（api.md §8）；如未来返回再设为可选字段
}

const ACTOR_RETRY_LIMIT = 2

export const AdminAuditLogs = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const loadedRef = useRef(false)

  const [actionFilter, setActionFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')
  /* 已应用的筛选条件快照，理由同 AdminUsers：输入框的值直接进 fetchPage 的话，
     改了筛选但没点搜索就翻页会发出「新筛选 + 旧游标」的请求。 */
  const appliedFiltersRef = useRef({ action: '', resource: '' })
  const [actorNames, setActorNames] = useState<Record<string, string>>({})
  /* 操作者名称查询的重试信号。失败时无条件递增，把 effect 再踢一遍。
     不封顶是安全的：次数上限记在**每个 ID 自己**头上（actorAttemptsRef），
     达到上限的 ID 会被过滤掉，ids 为空时 effect 直接返回，不会再 setState。
     若把上限记在这个共享计数上，一批操作者失败耗尽额度后，之后翻页遇到的
     新操作者就再也没有重试机会了。 */
  const [actorRetry, setActorRetry] = useState(0)
  /** 每个操作者 ID 各自的失败次数。 */
  const actorAttemptsRef = useRef<Map<string, number>>(new Map())
  /* 已经拿到名字的操作者 ID。只有成功才进这个集合——失败的要能被后续 effect 重试。 */
  const actorResolvedRef = useRef<Set<string>>(new Set())
  /* 本轮正在查的 ID。它和 resolved 分开记，是因为「正在查」必须在 effect cleanup 里
     **同步**撤回：下一轮 effect 紧接着 cleanup 运行，若等异步 continuation 再撤回，
     它早已跳过这些 ID，之后再没有人去查，操作者名称会永久停在截断的 ID 上。 */
  const actorInFlightRef = useRef<Set<string>>(new Set())

  const actionLabel = (action: string): string => t(`adminAuditLogs.actions.${action.replace(/\./g, '_')}`, action)

  // 游标分页列表（统一模板）：筛选由 onSearch 显式触发 reload
  const { items: logs, pageIndex, knownPages, hasMore, stale, staleResults, loading, error, reload, goToPage } = usePagedList<AuditLogEntry>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '50' })
      const applied = appliedFiltersRef.current
      if (applied.action) params.set('action', applied.action)
      if (applied.resource) params.set('resourceType', applied.resource)
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<AuditLogEntry[]>(`/admin/audit-logs?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [authLoading, accessToken],
    autoLoad: false,
  })

  // 首载：auth 就绪且持有 audit:read 时加载一次；无权限不发起
  useEffect(() => {
    if (authLoading || !accessToken) return
    if (!hasPermission(permissions, PERMISSIONS.AUDIT_READ)) return // 无 audit:read 直接拒绝页，免发无谓 403
    if (loadedRef.current) return
    loadedRef.current = true
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  const applyFilters = (action: string, resource: string) => {
    appliedFiltersRef.current = { action, resource }
    void reload()
  }

  const searchLogs = () => applyFilters(actionFilter.trim(), resourceFilter.trim())

  /* 清除按钮必须同步「已应用」的筛选并重载，理由同 AdminUsers。
     另一个框取它**当前显示**的值，而不是上次已应用的值：用户可能已经把资源框
     改成了 R2 但还没点搜索，此时清掉 action 若沿用旧的 R1，界面显示的是 R2、
     实际查的却是 R1，之后翻页也一直用错的条件。 */
  const clearAction = () => applyFilters('', resourceFilter.trim())
  const clearResource = () => applyFilters(actionFilter.trim(), '')

  /* 操作者 ID → 显示名查表（需 user:read 权限）。
     三个状态分得很清楚：
       · resolvedRef —— 已经拿到名字，永不重查；只在名字**真的写进** actorNames
         的那一刻才登记。若在写入前就登记，一轮被取消的查询会留下「已解决」的
         假象，而名字从未落地，该操作者此后永远只显示截断 ID。
       · inFlightRef —— 本轮正在查。必须在 cleanup 里**同步**撤回：下一轮 effect
         紧接着 cleanup 运行，等异步 continuation 再撤回就晚了。
       · attempts —— 每个 ID 各自的失败次数，达到上限就不再查它；配合
         retry 信号，既能从网络抖动里恢复，又不会在持续故障时无限重试。 */
  useEffect(() => {
    if (!accessToken || !hasPermission(permissions, PERMISSIONS.USER_READ)) return
    const ids = Array.from(new Set(logs.map((l) => l.actorUserId).filter((x): x is string => !!x))).filter(
      (id) =>
        !actorResolvedRef.current.has(id) &&
        !actorInFlightRef.current.has(id) &&
        (actorAttemptsRef.current.get(id) ?? 0) < ACTOR_RETRY_LIMIT,
    )
    if (ids.length === 0) return
    // 在 effect 内取出集合本身，cleanup 用这个局部变量（Set 的身份不变，只是内容变）
    const inFlight = actorInFlightRef.current
    const resolved = actorResolvedRef.current
    const attempts = actorAttemptsRef.current
    ids.forEach((id) => inFlight.add(id))
    let cancelled = false
    void (async () => {
      // 限制并发数到 4，避免同时发起大量请求触发后端限流
      const CONCURRENCY = 4
      const entries: Array<[string, string] | null> = []
      /* 失败的 ID 先攒着，等确认本轮没被取消再计入 attempts。
         被取消的那一轮不该消耗任何人的重试额度：用户只是翻了个页，
         接口恢复后这些名字还得能查回来。 */
      const failedIds: string[] = []
      try {
        for (let i = 0; i < ids.length; i += CONCURRENCY) {
          const batch = ids.slice(i, i + CONCURRENCY)
          const batchResults = await Promise.all(
            batch.map(async (id) => {
              const r = await get<{ displayName?: string; username?: string }>(`/admin/users/${id}`, {
                /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
              })
              if (r.ok) return [id, r.data.displayName || r.data.username || id] as [string, string]
              failedIds.push(id)
              return null
            }),
          )
          // 本轮被取消：in-flight 标记由 cleanup 同步撤回，这里直接收手，
          // 且**不**把任何 ID 记为 resolved——它们的名字并没有写进界面。
          if (cancelled) return
          entries.push(...batchResults)
        }
        const map: Record<string, string> = {}
        for (const e of entries) {
          if (!e) continue
          map[e[0]] = e[1]
          resolved.add(e[0])
        }
        if (Object.keys(map).length) setActorNames((prev) => ({ ...prev, ...map }))
        if (failedIds.length > 0) {
          failedIds.forEach((id) => attempts.set(id, (attempts.get(id) ?? 0) + 1))
          // 再踢一轮；是否真的重试由每个 ID 自己的 attempts 上限决定
          setActorRetry((n) => n + 1)
        }
      } finally {
        if (!cancelled) ids.forEach((id) => inFlight.delete(id))
      }
    })()
    return () => {
      cancelled = true
      // 同步撤回，让紧接着运行的下一轮 effect 能重新查这些 ID
      ids.forEach((id) => inFlight.delete(id))
    }
    /* 依赖里必须带上 accessToken/permissions：只有 audit:read 时首屏会因权限不足
       直接返回，此后即使拿到 user:read，logs 没变就不会重跑，操作者名称永远缺失。 */
  }, [logs, accessToken, permissions, actorRetry])

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
          <SearchField
            value={resourceFilter}
            onValueChange={setResourceFilter}
            onSearch={searchLogs}
            onClear={clearResource}
            placeholder={t('adminAuditLogs.filterResource')}
            searchAriaLabel={t('adminAuditLogs.filterResource')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          <AdminButton variant="secondary" onClick={searchLogs}>
            {t('adminAuditLogs.search')}
          </AdminButton>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && logs.length === 0 ? (
        <Skeleton rows={8} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
         对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
      staleResults ? null : logs.length === 0 ? (
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
              <li key={log.id} className={shell.rowStatic}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>{actionLabel(log.action)}</span>
                  <span className={shell.rowMeta}>
                    <code className={shell.code}>{log.action}</code>
                    <span className={shell.rowMetaSep}>·</span>
                    {log.actorUserId
                      ? t('adminAuditLogs.actorUser', {
                          id: actorNames[log.actorUserId] ?? `${limitByUnicode(log.actorUserId, 12)}…`,
                        })
                      : t('adminAuditLogs.actorSystem')}
                    {log.resourceId && (
                      <>
                        <span className={shell.rowMetaSep}>·</span>
                        {`${limitByUnicode(log.resourceId, 24)}…`}
                      </>
                    )}
                    <span className={shell.rowMetaSep}>·</span>
                    {formatTs(log.createdAt)}
                  </span>
                </span>
                <span className={shell.rowRight}>
                  <Pill>{log.resourceType}</Pill>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
          （并发删除、状态变更、游标过期），读者仍需要能退回上一页。
          控件本身在只有一页时会自行隐藏。 */}
      <Pagination
        pageIndex={pageIndex}
        knownPages={knownPages}
        hasMore={hasMore}
        disabled={loading || stale}
        onChange={goToPage}
      />
    </div>
  )
}
