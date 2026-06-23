import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { limitByUnicode } from '@/utils/string'
import {
  AdminButton,
  Alert,
  EmptyState,
  Pill,
  SearchField,
  Spinner,
} from '@/components/admin'
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

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const AdminAuditLogs = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, user, permissions } = useAuth()
  const loadedRef = useRef(false)
  const fetchSeq = useRef(0)

  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')
  const [actorNames, setActorNames] = useState<Record<string, string>>({})
  const actorFetchedRef = useRef<Set<string>>(new Set())

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

  const actionLabel = (action: string): string =>
    t(`adminAuditLogs.actions.${action.replace(/\./g, '_')}`, action)

  const fetchLogs = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (actionFilter.trim()) params.set('action', actionFilter.trim())
      if (resourceFilter.trim()) params.set('resourceType', resourceFilter.trim())
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<AuditLogEntry[]>(`/admin/audit-logs?${params}`, {
        headers: authHeaders(), skipRefresh: !accessToken,
      })
      if (seq !== fetchSeq.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setLogs(prev => [...prev, ...result.data])
      else setLogs(result.data)
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminAuditLogs.loadError'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (authLoading || !accessToken) return
    if (!hasPermission(permissions, PERMISSIONS.AUDIT_READ)) return  // 无 audit:read 直接拒绝页，免发无谓 403
    if (loadedRef.current) return
    loadedRef.current = true
    fetchLogs()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  // 操作者 ID → 显示名查表（需 user:read 权限；按 ID 缓存，避免重复请求）
  useEffect(() => {
    if (!accessToken || !hasPermission(permissions, PERMISSIONS.USER_READ)) return
    const ids = Array.from(new Set(logs.map(l => l.actorUserId).filter((x): x is string => !!x)))
      .filter(id => !actorFetchedRef.current.has(id))
    if (ids.length === 0) return
    ids.forEach(id => actorFetchedRef.current.add(id))
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(ids.map(async (id) => {
        const r = await get<{ displayName?: string; username?: string }>(`/admin/users/${id}`, {
          headers: authHeaders(), skipRefresh: !accessToken,
        })
        return r.ok ? ([id, r.data.displayName || r.data.username || id] as const) : null
      }))
      if (cancelled) return
      const map: Record<string, string> = {}
      for (const e of entries) if (e) map[e[0]] = e[1]
      if (Object.keys(map).length) setActorNames(prev => ({ ...prev, ...map }))
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs])

  if (!authLoading && (!user || !hasPermission(permissions, PERMISSIONS.AUDIT_READ))) {
    return (
      <div className={shell.page}>
        <EmptyState title={t('adminAuditLogs.accessDenied')} description={t('adminAuditLogs.accessDeniedDetail')} />
      </div>
    )
  }

  if (authLoading) {
    return (
      <div className={shell.page}>
        <Spinner size="md" label={t('adminAuditLogs.loading')} />
      </div>
    )
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <SearchField
            value={actionFilter}
            onValueChange={setActionFilter}
            onSearch={() => fetchLogs()}
            placeholder={t('adminAuditLogs.filterAction')}
            searchAriaLabel={t('adminAuditLogs.filterAction')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          <SearchField
            value={resourceFilter}
            onValueChange={setResourceFilter}
            onSearch={() => fetchLogs()}
            placeholder={t('adminAuditLogs.filterResource')}
            searchAriaLabel={t('adminAuditLogs.filterResource')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          <AdminButton variant="secondary" onClick={() => fetchLogs()}>{t('adminAuditLogs.search')}</AdminButton>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && logs.length === 0 ? (
        <Spinner size="md" label={t('adminAuditLogs.loading')} />
      ) : logs.length === 0 ? (
        <EmptyState title={t('adminAuditLogs.empty')} />
      ) : (
        <>
          <ul className={shell.list}>
            {logs.map(log => (
              <li key={log.id} className={shell.rowStatic}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>{actionLabel(log.action)}</span>
                  <span className={shell.rowMeta}>
                    <code className={shell.code}>{log.action}</code>
                    <span className={shell.rowMetaSep}>·</span>
                    {log.actorUserId
                      ? t('adminAuditLogs.actorUser', { id: actorNames[log.actorUserId] ?? `${limitByUnicode(log.actorUserId, 12)}…` })
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
          {cursor && (
            <div className={shell.loadMoreWrap}>
              <AdminButton variant="secondary" onClick={() => fetchLogs(cursor)} loading={loading}>
                {t('adminAuditLogs.loadMore')}
              </AdminButton>
            </div>
          )}
        </>
      )}
    </div>
  )
}
