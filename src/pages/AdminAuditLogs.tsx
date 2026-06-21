import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { limitByUnicode } from '@/utils/string'
import styles from './Admin.module.css'

interface AuditLogEntry {
  id: string
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown>
  createdAt: number
  requestId: string
  ipHash: string
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const AdminAuditLogs = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, user, isFullAdmin } = useAuth()
  const loadedRef = useRef(false)
  const fetchSeq = useRef(0)

  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

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
    if (loadedRef.current) return
    loadedRef.current = true
    fetchLogs()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  if (!authLoading && (!user || !isFullAdmin)) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('adminAuditLogs.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('adminAuditLogs.accessDeniedDetail')}</p>
      </main>
    )
  }

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('adminAuditLogs.loading')}</div>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header><h1 className={styles.heading}>{t('adminAuditLogs.title')}</h1></header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input type="text" value={actionFilter} onChange={e => setActionFilter(e.target.value)}
          placeholder={t('adminAuditLogs.filterAction')}
          aria-label={t('adminAuditLogs.filterActionAria', '操作类型筛选')}
          className={styles.input}
          style={{ flex: 1, minWidth: '200px', padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          onKeyDown={e => { if (e.key === 'Enter') fetchLogs() }} />
        <input type="text" value={resourceFilter} onChange={e => setResourceFilter(e.target.value)}
          placeholder={t('adminAuditLogs.filterResource')}
          aria-label={t('adminAuditLogs.filterResourceAria', '资源类型筛选')}
          className={styles.input}
          style={{ flex: 1, minWidth: '150px', padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          onKeyDown={e => { if (e.key === 'Enter') fetchLogs() }} />
        <button className={styles.btnSecondary} onClick={() => fetchLogs()}>{t('adminAuditLogs.search')}</button>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {loading && logs.length === 0 ? (
        <div className={styles.loading}>{t('adminAuditLogs.loading')}</div>
      ) : logs.length === 0 ? (
        <div className={styles.empty}>{t('adminAuditLogs.empty')}</div>
      ) : (
        <>
          <ul className={styles.list}>
            {logs.map(log => (
              <li key={log.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{log.action}</div>
                  <div className={styles.itemMeta}>
                    {log.resourceType}{log.resourceId ? ` / ${limitByUnicode(log.resourceId, 24)}...` : ''} ·
                    {log.actorUserId
                      ? t('adminAuditLogs.actorUser', { id: `${limitByUnicode(log.actorUserId, 16)}...` })
                      : t('adminAuditLogs.actorSystem')} ·
                    {formatTs(log.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {cursor && (
            <button className={styles.btnSecondary} onClick={() => fetchLogs(cursor)}
              disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
              {t('adminAuditLogs.loadMore')}
            </button>
          )}
        </>
      )}
    </main>
  )
}
