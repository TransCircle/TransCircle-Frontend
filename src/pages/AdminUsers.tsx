import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { StepUpDialog } from '@/components/StepUpDialog'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  ReasonPromptDialog,
  SearchField,
  SectionLabel,
  Spinner,
  StatusBadge,
  USER_STATUS_TONE,
  USER_STATUS_LABEL_KEYS,
  type DescriptionItem,
} from '@/components/admin'
import shell from './Page.module.css'

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
  const { accessToken, loading: authLoading, user, permissions } = useAuth()
  const loadedRef = useRef(false)
  const fetchSeq = useRef(0)

  const [users, setUsers] = useState<ManagedUser[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailedUser | null>(null)

  // 危险操作（封禁/解封）可能返回 STEP_UP_REQUIRED → 弹 step-up（IAM 账号走代理 2FA 跳转）。
  const [showStepUp, setShowStepUp] = useState(false)
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null)

  // 封禁原因对话框（替代内联输入行）
  const [banDialogUserId, setBanDialogUserId] = useState<string | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState('')

  const fetchUsers = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<ManagedUser[]>(`/admin/users?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (seq !== fetchSeq.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setUsers((prev) => [...prev, ...result.data])
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
    if (!hasPermission(permissions, PERMISSIONS.USER_READ)) return // 无 user:read 直接拒绝页，免发无谓 403
    if (loadedRef.current) return
    loadedRef.current = true
    fetchUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  const fetchDetail = async (userId: string) => {
    setSelectedId(userId)
    const result = await get<DetailedUser>(`/admin/users/${userId}`, {
      /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
    })
    if (result.ok) setDetail(result.data)
    else setError(result.error.message)
  }

  const openBan = (userId: string) => {
    setBanReason('')
    setBanError('')
    setError('')
    setBanDialogUserId(userId)
  }

  const submitBan = async () => {
    if (!banDialogUserId) return
    const reason = banReason.trim()
    // 封禁理由 1-500 字符（api.md §7.5 / 后端 admin.ts 校验一致）
    if (!reason || reason.length > 500) {
      setBanError(t('adminUsers.banReasonRequired'))
      return
    }
    const userId = banDialogUserId
    setBanDialogUserId(null)
    setBanError('')
    const doBan = async () => {
      const result = await post(
        `/admin/users/${userId}/ban`,
        { reason },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (result.ok) {
        fetchDetail(userId)
        fetchUsers()
      } else if (result.error.code === 'STEP_UP_REQUIRED') {
        pendingActionRef.current = doBan
        setShowStepUp(true)
      } else setError(result.error.message)
    }
    await doBan()
  }

  const handleUnban = async (userId: string) => {
    const doUnban = async () => {
      const result = await post(
        `/admin/users/${userId}/unban`,
        { reason: t('adminUsers.adminUnban') },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (result.ok) {
        fetchDetail(userId)
        fetchUsers()
      } else if (result.error.code === 'STEP_UP_REQUIRED') {
        pendingActionRef.current = doUnban
        setShowStepUp(true)
      } else setError(result.error.message)
    }
    await doUnban()
  }

  if (!authLoading && (!user || !hasPermission(permissions, PERMISSIONS.USER_READ))) {
    return (
      <div className={shell.page}>
        <EmptyState title={t('adminUsers.accessDenied')} description={t('adminUsers.accessDeniedDetail')} />
      </div>
    )
  }

  if (authLoading) {
    return (
      <div className={shell.page}>
        <Spinner size="md" label={t('adminUsers.loading')} />
      </div>
    )
  }

  if (selectedId && detail) {
    const metaItems: DescriptionItem[] = [
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
      {
        term: t('adminUsers.status'),
        value: (
          <StatusBadge
            tone={USER_STATUS_TONE[detail.status] ?? 'neutral'}
            label={t(USER_STATUS_LABEL_KEYS[detail.status] ?? detail.status)}
            size="sm"
          />
        ),
      },
      { term: t('adminUsers.createdAt'), value: formatTs(detail.createdAt) || '—' },
      { term: t('adminUsers.lastLogin'), value: formatTs(detail.lastLoginAt) || '—' },
      {
        term: t('adminUsers.passwordLabel'),
        value: detail.security.hasPassword ? t('adminUsers.hasPassword') : t('adminUsers.noPassword'),
      },
      { term: 'TOTP', value: detail.security.totpEnabled ? t('adminUsers.totpEnabled') : t('adminUsers.totpDisabled') },
      { term: 'Passkey', value: `${detail.security.passkeyCount}${t('adminUsers.passkeyUnit')}` },
    ]

    return (
      <div className={shell.page}>
        <div>
          <AdminButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedId(null)
              setDetail(null)
            }}
          >
            {t('adminUsers.backToList')}
          </AdminButton>
        </div>

        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>
              {detail.displayName} <span className={shell.detailTitleSub}>@{detail.username}</span>
            </h2>

            <DescriptionList items={metaItems} columns={2} />

            {detail.oauthAccounts.length > 0 && (
              <div>
                <SectionLabel>OAuth</SectionLabel>
                <ul className={shell.history}>
                  {detail.oauthAccounts.map((oa) => (
                    <li key={oa.provider} className={shell.historyItem}>
                      {t('adminUsers.oauthAccount', { provider: oa.provider, username: oa.providerUsername })}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <SectionLabel>{t('adminUsers.roles')}</SectionLabel>
              {detail.roles.length === 0 ? (
                <p className={shell.subtleNote}>{t('adminUsers.noRoles')}</p>
              ) : (
                <ul className={shell.history}>
                  {detail.roles.map((r) => (
                    <li key={r.id} className={shell.historyItem}>
                      {r.name}（
                      {r.expiresAt
                        ? t('adminUsers.expiresAt', { time: formatTs(r.expiresAt) })
                        : t('adminUsers.permanent')}
                      ）
                    </li>
                  ))}
                </ul>
              )}
              {/* 授权统一迁移到 IAM：本平台不再人工授予/撤销角色（iam-admin-api.md §4.4） */}
              <p className={shell.subtleNoteSpaced}>{t('adminUsers.rolesManagedInIam')}</p>
            </div>

            {error && <Alert tone="error">{error}</Alert>}

            {/* 封禁/解封需 user:ban（仅 admin）；editor 仅有 user:read 时只读不可操作 */}
            {hasPermission(permissions, PERMISSIONS.USER_BAN) && (
              <div className={shell.actions}>
                {detail.status === 'banned' ? (
                  <AdminButton variant="primary" onClick={() => handleUnban(detail.id)}>
                    {t('adminUsers.unban')}
                  </AdminButton>
                ) : (
                  <AdminButton variant="danger" onClick={() => openBan(detail.id)}>
                    {t('adminUsers.ban')}
                  </AdminButton>
                )}
              </div>
            )}
          </div>
        </Card>

        <ReasonPromptDialog
          open={banDialogUserId !== null}
          title={t('adminUsers.banTitle')}
          prompt={t('adminUsers.banReasonPrompt')}
          placeholder={t('adminUsers.banReasonPlaceholder')}
          value={banReason}
          onChange={setBanReason}
          onSubmit={submitBan}
          onCancel={() => {
            setBanDialogUserId(null)
            setBanError('')
          }}
          submitText={t('adminUsers.ban')}
          cancelText={t('admin.cancelReason')}
          maxLength={500}
          counterText={t('admin.ui.charCount', { n: banReason.length, max: 500 })}
          error={banError || undefined}
          variant="danger"
        />

        {showStepUp && accessToken && (
          <StepUpDialog
            accessToken={accessToken}
            onSuccess={() => {
              setShowStepUp(false)
              const a = pendingActionRef.current
              pendingActionRef.current = null
              void a?.()
            }}
            onCancel={() => {
              setShowStepUp(false)
              pendingActionRef.current = null
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <SearchField
            value={keyword}
            onValueChange={setKeyword}
            onSearch={() => fetchUsers()}
            placeholder={t('adminUsers.searchPlaceholder')}
            searchAriaLabel={t('adminUsers.searchPlaceholder')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          <AdminButton variant="secondary" onClick={() => fetchUsers()}>
            {t('adminUsers.search')}
          </AdminButton>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && users.length === 0 ? (
        <Spinner size="md" label={t('adminUsers.loading')} />
      ) : users.length === 0 ? (
        <EmptyState title={t('adminUsers.empty')} />
      ) : (
        <ul className={shell.list}>
          {users.map((u) => (
            <li key={u.id}>
              <button type="button" className={shell.rowBtn} onClick={() => fetchDetail(u.id)}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>{u.displayName}</span>
                  <span className={shell.rowMeta}>
                    @{u.username}
                    <span className={shell.rowMetaSep}>·</span>
                    {u.email ?? '—'}
                  </span>
                </span>
                <span className={shell.rowRight}>
                  <StatusBadge
                    tone={USER_STATUS_TONE[u.status] ?? 'neutral'}
                    label={t(USER_STATUS_LABEL_KEYS[u.status] ?? u.status)}
                    size="sm"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <div className={shell.loadMoreWrap}>
          <AdminButton variant="secondary" onClick={() => fetchUsers(cursor)} loading={loading}>
            {t('adminUsers.loadMore')}
          </AdminButton>
        </div>
      )}
    </div>
  )
}
