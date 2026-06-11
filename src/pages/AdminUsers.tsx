import { useState, useEffect, useCallback } from 'react'
import { get, post, del } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

interface ManagedUser {
  id: string
  username: string
  displayName: string
  email: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  createdAt: number
  lastLoginAt: number | null
}

interface DetailedUser extends ManagedUser {
  avatarUrl: string | null
  oauthAccounts: Array<{ provider: string; providerUsername: string; boundAt: number }>
  security: { hasPassword: boolean; totpEnabled: boolean; passkeyCount: number }
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const AdminUsers = () => {
  const { accessToken, loading: authLoading } = useAuth()

  const [users, setUsers] = useState<ManagedUser[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailedUser | null>(null)

  const authHeaders = useCallback((): Record<string, string> => {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  }, [accessToken])

  const fetchUsers = async (cursorVal?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<ManagedUser[]>(`/admin/users?${params}`, {
        headers: authHeaders(), skipRefresh: !accessToken,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setUsers(prev => [...prev, ...result.data])
      else setUsers(result.data)
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
    fetchUsers()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  const fetchDetail = async (userId: string) => {
    setSelectedId(userId)
    const result = await get<DetailedUser>(`/admin/users/${userId}`, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) setDetail(result.data)
    else setError(result.error.message)
  }

  const handleBan = async (userId: string) => {
    const reason = prompt('封禁原因：')
    if (!reason) return
    const result = await post(`/admin/users/${userId}/ban`, { reason }, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) { fetchDetail(userId); fetchUsers() }
    else setError(result.error.message)
  }

  const handleUnban = async (userId: string) => {
    const result = await post(`/admin/users/${userId}/unban`, { reason: '管理员解封' }, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) { fetchDetail(userId); fetchUsers() }
    else setError(result.error.message)
  }

  const handleGrantRole = async (userId: string) => {
    const roleId = prompt('角色 ID（如 role_reviewer）：')
    if (!roleId) return
    const result = await post(`/admin/users/${userId}/roles`, { roleId }, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) fetchDetail(userId)
    else setError(result.error.message)
  }

  const handleRevokeRole = async (userId: string, roleId: string) => {
    const result = await del(`/admin/users/${userId}/roles/${roleId}`, undefined, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) fetchDetail(userId)
    else setError(result.error.message)
  }

  if (selectedId && detail) {
    return (
      <main className={styles.container}>
        <button className={styles.back} onClick={() => { setSelectedId(null); setDetail(null) }}>
          ← 返回列表
        </button>
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>{detail.displayName} (@{detail.username})</h2>
          <div className={styles.detailMeta}>
            <p>邮箱：{detail.email ?? '-'} {detail.emailVerified ? '✓' : '✗'}</p>
            <p>状态：{detail.status}</p>
            <p>注册时间：{formatTs(detail.createdAt)}</p>
            <p>上次登录：{formatTs(detail.lastLoginAt)}</p>
            <p>密码：{detail.security.hasPassword ? '已设置' : '未设置'} · TOTP：{detail.security.totpEnabled ? '已启用' : '未启用'} · Passkey：{detail.security.passkeyCount} 个</p>
            {detail.oauthAccounts.map(oa => (
              <p key={oa.provider}>OAuth {oa.provider}: @{oa.providerUsername}</p>
            ))}
          </div>
          <h3 style={{ marginTop: '1rem', fontWeight: 600 }}>角色</h3>
          <ul>
            {(detail.roles as unknown as Array<{ id: string; name: string; expiresAt: number | null }>).map(r => (
              <li key={r.id}>
                {r.name}（{r.expiresAt ? `过期 ${formatTs(r.expiresAt)}` : '永久'}）
                <button onClick={() => handleRevokeRole(detail.id, r.id)}
                  style={{ marginLeft: '0.5rem', color: '#c62828', cursor: 'pointer', background: 'none', border: 'none' }}>
                  撤销
                </button>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button className={styles.btnPrimary} onClick={() => handleGrantRole(detail.id)}>授予角色</button>
            {detail.status === 'banned'
              ? <button className={styles.btnPrimary} onClick={() => handleUnban(detail.id)}>解封</button>
              : <button className={styles.btnSecondary} onClick={() => handleBan(detail.id)} style={{ color: '#c62828' }}>封禁</button>
            }
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header><h1 className={styles.heading}>用户管理</h1></header>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input type="text" value={keyword} onChange={e => setKeyword(e.target.value)}
          placeholder="搜索用户名/邮箱/显示名称" className={styles.input} style={{ flex: 1 }}
          onKeyDown={e => { if (e.key === 'Enter') fetchUsers() }} />
        <button className={styles.btnSecondary} onClick={() => fetchUsers()}>搜索</button>
      </div>
      {error && <div className={styles.errorBox}>{error}</div>}
      {loading && users.length === 0 ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <ul className={styles.list}>
          {users.map(u => (
            <li key={u.id} className={styles.item} role="button" tabIndex={0}
              onClick={() => fetchDetail(u.id)}>
              <div className={styles.itemMain}>
                <div className={styles.itemTitle}>{u.displayName}</div>
                <div className={styles.itemMeta}>@{u.username} · {u.email ?? '-'} · {u.status}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button className={styles.btnSecondary} onClick={() => fetchUsers(cursor)}
          disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
          加载更多
        </button>
      )}
    </main>
  )
}
