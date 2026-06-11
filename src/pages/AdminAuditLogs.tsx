import { useState, useEffect } from 'react'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

interface AuditLogEntry {
  id: string
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
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
  const { accessToken, loading: authLoading } = useAuth()

  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

  const fetchLogs = async (cursorVal?: string | null) => {
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
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setLogs(prev => [...prev, ...result.data])
      else setLogs(result.data)
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authLoading || !accessToken) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchLogs()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  return (
    <main className={styles.container}>
      <header><h1 className={styles.heading}>审计日志</h1></header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input type="text" value={actionFilter} onChange={e => setActionFilter(e.target.value)}
          placeholder="按操作类型过滤（如 auth.login.success）" className={styles.input}
          style={{ flex: 1, minWidth: '200px', padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          onKeyDown={e => { if (e.key === 'Enter') fetchLogs() }} />
        <input type="text" value={resourceFilter} onChange={e => setResourceFilter(e.target.value)}
          placeholder="按资源类型过滤（如 contribution）" className={styles.input}
          style={{ flex: 1, minWidth: '150px', padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          onKeyDown={e => { if (e.key === 'Enter') fetchLogs() }} />
        <button className={styles.btnSecondary} onClick={() => fetchLogs()}>搜索</button>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {loading && logs.length === 0 ? (
        <div className={styles.loading}>加载中...</div>
      ) : logs.length === 0 ? (
        <div className={styles.empty}>暂无审计日志</div>
      ) : (
        <>
          <ul className={styles.list}>
            {logs.map(log => (
              <li key={log.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{log.action}</div>
                  <div className={styles.itemMeta}>
                    {log.resourceType}{log.resourceId ? ` / ${log.resourceId.slice(0, 24)}...` : ''} ·
                    {log.actorUserId ? ` 操作者 ${log.actorUserId.slice(0, 16)}... ·` : ' 系统 ·'}
                    {formatTs(log.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {cursor && (
            <button className={styles.btnSecondary} onClick={() => fetchLogs(cursor)}
              disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
              加载更多
            </button>
          )}
        </>
      )}
    </main>
  )
}
