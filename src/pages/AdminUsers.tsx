import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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

interface RoleEntry {
  id: string
  name: string
  grantedBy: string
  createdAt: number
  expiresAt: number | null
}

interface DetailedUser extends Omit<ManagedUser, 'roles'> {
  avatarUrl: string | null
  oauthAccounts: Array<{ provider: string; providerUsername: string; boundAt: number }>
  security: { hasPassword: boolean; totpEnabled: boolean; passkeyCount: number }
  roles: RoleEntry[]
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const AdminUsers = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, user, isFullAdmin } = useAuth()
  const loadedRef = useRef(false)
  const fetchSeq = useRef(0)

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
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<ManagedUser[]>(`/admin/users?${params}`, {
        headers: authHeaders(), skipRefresh: !accessToken,
      })
      if (seq !== fetchSeq.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setUsers(prev => [...prev, ...result.data])
      else setUsers(result.data)
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminUsers.loadError'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (authLoading || !accessToken) return
    if (loadedRef.current) return
    loadedRef.current = true
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

  const [banReason, setBanReason] = useState('')
  const [banUserId, setBanUserId] = useState<string | null>(null)

  const handleBan = async (userId: string) => {
    if (banUserId !== userId) {
      setBanUserId(userId)
      setBanReason('')
      setError('')
      return
    }
    const reason = banReason.trim()
    if (!reason || reason.length > 200) {
      setError(t('adminUsers.banReasonRequired'))
      return
    }
    setBanUserId(null)
    setBanReason('')
    const result = await post(`/admin/users/${userId}/ban`, { reason }, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) { fetchDetail(userId); fetchUsers() }
    else setError(result.error.message)
  }

  const handleUnban = async (userId: string) => {
      const result = await post(`/admin/users/${userId}/unban`, { reason: t('adminUsers.adminUnban') }, {
      headers: authHeaders(), skipRefresh: !accessToken,
    })
    if (result.ok) { fetchDetail(userId); fetchUsers() }
    else setError(result.error.message)
  }

  const [roleInput, setRoleInput] = useState('')
  const [roleUserId, setRoleUserId] = useState<string | null>(null)

  const handleGrantRole = async (userId: string) => {
    if (roleUserId !== userId) {
      setRoleUserId(userId)
      setRoleInput('')
      setError('')
      return
    }
    const roleId = roleInput.trim()
    if (!roleId) {
      setError(t('adminUsers.roleIdRequired'))
      return
    }
    setRoleUserId(null)
    setRoleInput('')
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

  if (!authLoading && (!user || !isFullAdmin)) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('adminUsers.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('adminUsers.accessDeniedDetail')}</p>
      </main>
    )
  }

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('adminUsers.loading')}</div>
      </main>
    )
  }

  if (selectedId && detail) {
    return (
      <main className={styles.container}>
        <button className={styles.back} onClick={() => { setSelectedId(null); setDetail(null) }}>
          {t('adminUsers.backToList')}
        </button>
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>{detail.displayName} (@{detail.username})</h2>
          <div className={styles.detailMeta}>
            <p>{t('adminUsers.email')}：{detail.email ?? '-'} {detail.emailVerified ? '✓' : '✗'}</p>
            <p>{t('adminUsers.status')}：{detail.status}</p>
            <p>{t('adminUsers.createdAt')}：{formatTs(detail.createdAt)}</p>
            <p>{t('adminUsers.lastLogin')}：{formatTs(detail.lastLoginAt)}</p>
            <p>{t('adminUsers.passwordLabel')}：{detail.security.hasPassword ? t('adminUsers.hasPassword') : t('adminUsers.noPassword')} · TOTP：{detail.security.totpEnabled ? t('adminUsers.totpEnabled') : t('adminUsers.totpDisabled')} · Passkey：{detail.security.passkeyCount}{t('adminUsers.passkeyUnit')}</p>
            {detail.oauthAccounts.map(oa => (
              <p key={oa.provider}>{t('adminUsers.oauthAccount', { provider: oa.provider, username: oa.providerUsername })}</p>
            ))}
          </div>
          <h3 style={{ marginTop: '1rem', fontWeight: 600 }}>{t('adminUsers.roles')}</h3>
          <ul>
            {detail.roles.map(r => (
              <li key={r.id}>
                {r.name}（{r.expiresAt ? t('adminUsers.expiresAt', { time: formatTs(r.expiresAt) }) : t('adminUsers.permanent')}）
                <button onClick={() => handleRevokeRole(detail.id, r.id)}
                  style={{ marginLeft: '0.5rem', color: 'var(--error-color)', cursor: 'pointer', background: 'none', border: 'none' }}>
                  {t('adminUsers.revokeRole')}
                </button>
              </li>
            ))}
          </ul>
          {error && <div className={styles.errorBox} role="alert">{error}</div>}

          {/* Inline ban reason input */}
          {banUserId === detail.id && (
            <div style={{ margin: '1rem 0', padding: '0.75rem', border: '1px solid var(--divider-color)', borderRadius: '8px', background: 'var(--hover-bg)' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {t('adminUsers.banReasonPrompt')}
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input type="text" value={banReason} onChange={e => setBanReason(e.target.value)}
                  placeholder={t('adminUsers.banReasonPlaceholder')} autoFocus
                  style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleBan(detail.id)
                    if (e.key === 'Escape') { setBanUserId(null); setBanReason('') }
                  }} />
                <button className={styles.btnPrimary} onClick={() => handleBan(detail.id)}
                  style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>{t('admin.confirmReason')}</button>
                <button className={styles.btnSecondary} onClick={() => { setBanUserId(null); setBanReason('') }}
                  style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>{t('admin.cancelReason')}</button>
              </div>
            </div>
          )}

          {/* Inline role ID input */}
          {roleUserId === detail.id && (
            <div style={{ margin: '1rem 0', padding: '0.75rem', border: '1px solid var(--divider-color)', borderRadius: '8px', background: 'var(--hover-bg)' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {t('adminUsers.roleIdPrompt')}
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input type="text" value={roleInput} onChange={e => setRoleInput(e.target.value)}
                  placeholder={t('adminUsers.roleIdPlaceholder')} autoFocus
                  style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleGrantRole(detail.id)
                    if (e.key === 'Escape') { setRoleUserId(null); setRoleInput('') }
                  }} />
                <button className={styles.btnPrimary} onClick={() => handleGrantRole(detail.id)}
                  style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>{t('admin.confirmReason')}</button>
                <button className={styles.btnSecondary} onClick={() => { setRoleUserId(null); setRoleInput('') }}
                  style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>{t('admin.cancelReason')}</button>
              </div>
            </div>
          )}

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button className={styles.btnPrimary} onClick={() => handleGrantRole(detail.id)}>{t('adminUsers.grantRole')}</button>
            {detail.status === 'banned'
              ? <button className={styles.btnPrimary} onClick={() => handleUnban(detail.id)}>{t('adminUsers.unban')}</button>
              : <button className={styles.btnSecondary} onClick={() => handleBan(detail.id)} style={{ color: 'var(--error-color)' }}>{t('adminUsers.ban')}</button>
            }
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header><h1 className={styles.heading}>{t('adminUsers.title')}</h1></header>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input type="text" value={keyword} onChange={e => setKeyword(e.target.value)}
          placeholder={t('adminUsers.searchPlaceholder')} className={styles.input} style={{ flex: 1 }}
          onKeyDown={e => { if (e.key === 'Enter') fetchUsers() }} />
        <button className={styles.btnSecondary} onClick={() => fetchUsers()}>{t('adminUsers.search')}</button>
      </div>
      {error && <div className={styles.errorBox}>{error}</div>}
      {loading && users.length === 0 ? (
        <div className={styles.loading}>{t('adminUsers.loading')}</div>
      ) : (
        <ul className={styles.list}>
          {users.map(u => (
            <li key={u.id}>
              <button
                type="button"
                className={styles.itemButton}
                onClick={() => fetchDetail(u.id)}
              >
              <div className={styles.itemMain}>
                <div className={styles.itemTitle}>{u.displayName}</div>
                <div className={styles.itemMeta}>@{u.username} · {u.email ?? '-'} · {u.status}</div>
              </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button className={styles.btnSecondary} onClick={() => fetchUsers(cursor)}
          disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
          {t('adminUsers.loadMore')}
        </button>
      )}
    </main>
  )
}
