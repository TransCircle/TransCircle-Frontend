import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { API_BASE } from '@/config'
import styles from './Admin.module.css'

const TEMP_TOKEN_KEY = 'tc_temp_admin_token'
const TEMP_TOKEN_EXPIRY_KEY = 'tc_temp_admin_token_exp'
const TEMP_TOKEN_SESSION_KEY = 'tc_temp_admin_token_session'
const TEMP_TOKEN_MAX_AGE = 4 * 60 * 60 * 1000 // 4 hours (was 24h, reduced per S2)

type Status = 'pending' | 'approved' | 'rejected'
type ReviewAction = 'approved' | 'rejected'

interface Submission {
  id: string
  title: string
  category: string | null
  author_type?: string
  authorType?: string
  author_name?: string | null
  authorName?: string | null
  contact?: string | null
  content?: string
  contentRaw?: string
  status: Status
  version: number
  reviewer_gh?: string | null
  reviewerGh?: string | null
  review_notes?: string | null
  reviewNotes?: string | null
  created_at?: number
  createdAt?: number
  reviewed_at?: number | null
  reviewedAt?: number | null
  updated_at?: number
  updatedAt?: number
  submitter_gh?: string | null
  submitterGh?: string | null
  submitter_x?: string | null
  submitterX?: string | null
  author?: { id: string | null; displayName: string; avatarUrl: string | null }
}

interface ListResponse {
  submissions?: Submission[]
  data?: Submission[]
  pagination?: { nextCursor: string | null; hasMore: boolean; limit: number }
  nextCursor?: string | null
  limit?: number
}

const STATUS_LABEL_KEYS: Record<Status, string> = {
  pending: 'admin.statusPending',
  approved: 'admin.statusApproved',
  rejected: 'admin.statusRejected',
}

function getStoredToken(): string {
  try {
    // Prefer sessionStorage (cleared on tab close) over localStorage (persistent)
    let token = sessionStorage.getItem(TEMP_TOKEN_SESSION_KEY) || ''
    if (token) return token

    token = localStorage.getItem(TEMP_TOKEN_KEY) || ''
    if (!token) return ''    

    const exp = localStorage.getItem(TEMP_TOKEN_EXPIRY_KEY)
    if (exp && Date.now() > Number(exp)) {
      localStorage.removeItem(TEMP_TOKEN_KEY)
      localStorage.removeItem(TEMP_TOKEN_EXPIRY_KEY)
      return ''
    }
    return token
  } catch { return '' }
}

function formatTs(ts: number | string | null): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (isNaN(n)) return String(ts)
  return new Date(n).toISOString().slice(0, 16).replace('T', ' ')
}

export const Admin = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, accessToken, loginWithGitHub } = useAuth()
  const [tempToken, setTempToken] = useState(getStoredToken)
  const [tokenInput, setTokenInput] = useState('')
  const [activeTab, setActiveTab] = useState<Status>('pending')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Submission | null>(null)
  const [reviewNotes, setReviewNotes] = useState('')
  const [rememberDevice, setRememberDevice] = useState(false)
  const [pageLoadTs] = useState(() => Date.now())

  function getField(s: unknown, ...keys: string[]): unknown {
    if (typeof s !== 'object' || s === null) return null
    const obj = s as Record<string, unknown>
    for (const k of keys) {
      if (k in obj) return obj[k]
    }
    return null
  }

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {}
    if (accessToken) h.Authorization = `Bearer ${accessToken}`
    else if (tempToken) h.Authorization = `Bearer ${tempToken}`
    return h
  }, [accessToken, tempToken])

  const fetchSubmissions = useCallback(async (cursor?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ status: activeTab, limit: '50' })
      if (cursor) params.set('cursor', cursor)

      const res = await fetch(`${API_BASE}/admin/contributions?${params}`, { headers: authHeaders() })
      if (res.status === 403) {
        localStorage.removeItem(TEMP_TOKEN_KEY)
        localStorage.removeItem(TEMP_TOKEN_EXPIRY_KEY)
        setTempToken('')
        setLoading(false)
        return
      }
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } }
        throw new Error(body.error?.message ?? '加载失败')
      }
      const body = await res.json() as ListResponse

      const items = body.data ?? body.submissions ?? []
      const pageCursor = body.pagination?.nextCursor ?? body.nextCursor ?? null

      if (pageCursor) {
        setSubmissions(prev => [...prev, ...items])
      } else {
        setSubmissions(items)
      }
      setNextCursor(pageCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorLoad'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, authHeaders, t])

  useEffect(() => {
    if (!user?.isAdmin && !tempToken) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ status: activeTab, limit: '50' })
        const res = await fetch(`${API_BASE}/admin/contributions?${params}`, { headers: authHeaders() })
        if (cancelled) return

        if (res.status === 403) {
          localStorage.removeItem(TEMP_TOKEN_KEY)
          localStorage.removeItem(TEMP_TOKEN_EXPIRY_KEY)
          setTempToken('')
          return
        }
        if (!res.ok) {
          const body = await res.json() as { error?: { message?: string } }
          throw new Error(body.error?.message ?? t('admin.errorLoad'))
        }
        const body = await res.json() as ListResponse
        if (cancelled) return

        const items = body.data ?? body.submissions ?? []
        const pageCursor = body.pagination?.nextCursor ?? body.nextCursor ?? null
        setSubmissions(pageCursor ? prev => [...prev, ...items] : items)
        setNextCursor(pageCursor)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('admin.errorLoad'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [activeTab, user?.isAdmin, tempToken, authHeaders, t])

  const fetchDetail = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/admin/contributions/${id}`, { headers: authHeaders() })
      if (!res.ok) throw new Error('加载失败')
      const body = await res.json() as { data?: Submission }
      setSelected(body.data ?? null)
      setReviewNotes('')
    } catch {
      setError(t('admin.errorDetail'))
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    const v = selected.version || 1
    try {
      const res = await fetch(`${API_BASE}/admin/contributions/${selected.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          decision: action,
          internalNote: reviewNotes || undefined,
          expectedVersion: v,
        }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } }
        throw new Error(body.error?.message ?? '操作失败')
      }
      setSelected(null)
      fetchSubmissions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorReview'))
    }
  }

  // ── Loading ──

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </main>
    )
  }

  // ── Not logged in (no OAuth user + no temp token) ──

  if (!user && !tempToken) {
    const handleTempLogin = () => {
      if (tokenInput.trim()) {
        const expiry = Date.now() + TEMP_TOKEN_MAX_AGE
        if (rememberDevice) {
          localStorage.setItem(TEMP_TOKEN_KEY, tokenInput.trim())
          localStorage.setItem(TEMP_TOKEN_EXPIRY_KEY, String(expiry))
        } else {
          sessionStorage.setItem(TEMP_TOKEN_SESSION_KEY, tokenInput.trim())
        }
        setTempToken(tokenInput.trim())
      }
    }

    const expiryTime = new Date(pageLoadTs + TEMP_TOKEN_MAX_AGE).toLocaleTimeString()

    return (
      <main className={styles.container}>
        <header>
          <h1 className={styles.heading}>
            {t('admin.title')}
          </h1>
          <p className={styles.headingDesc}>
            {t('admin.description')}
          </p>
        </header>

        <div className={styles.loginBox}>
          <button className={`${styles.btnPrimary} ${styles.loginBoxBtn}`} onClick={loginWithGitHub}>
            {t('admin.loginWithGithub')}
          </button>

          <div className={styles.loginDivider}>
            <p className={styles.loginDescription}>
              {t('admin.tempTokenDescription')}
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('admin.tempTokenPlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleTempLogin()}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', margin: '0.5rem 0' }}>
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
              />
              <span>记住此设备（关闭标签页不清除，最长至 {expiryTime}）</span>
            </label>
            <button className={styles.btnSecondary} onClick={handleTempLogin}>
              {t('admin.tempTokenLogin')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  // ── Not admin (OAuth user but not in org) ──

  if (user && !user.isAdmin) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>
          {t('admin.accessDenied')}
        </h1>
        <p className={styles.headingDesc}>
          {t('admin.accessDeniedDetail', { username: user.username })}
        </p>
      </main>
    )
  }

  // ── Submission List ──

  if (!selected) {
    const tabs = [
      { key: 'pending' as Status, label: t('admin.tabs.pending') },
      { key: 'approved' as Status, label: t('admin.tabs.approved') },
      { key: 'rejected' as Status, label: t('admin.tabs.rejected') },
    ]

    const countLabel = nextCursor
      ? t('admin.countMore', { count: submissions.length })
      : t('admin.count', { count: submissions.length })

    return (
      <main className={styles.container}>
        <div className={styles.bar}>
          <div>
            <h1 className={styles.heading}>
              {t('admin.title')}
            </h1>
            <span className={styles.userInfo}>
              {user ? `${user.username} (${user.provider})` : `${t('admin.tempAdmin')}（临时令牌，${new Date(pageLoadTs + TEMP_TOKEN_MAX_AGE).toLocaleTimeString()} 过期）`}
            </span>
          </div>
        </div>

        <nav className={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className={styles.count}>{countLabel}</div>

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {loading && submissions.length === 0 ? (
          <div className={styles.loading}>{t('admin.loading')}</div>
        ) : submissions.length === 0 ? (
          <div className={styles.empty}>{t('admin.empty')}</div>
        ) : (
          <>
            <ul className={styles.list}>
              {submissions.map((s) => (
                <li
                  key={s.id}
                  className={styles.item}
                  role="button"
                  tabIndex={0}
                  onClick={() => fetchDetail(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      fetchDetail(s.id)
                    }
                  }}
                >
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>{s.title}</div>
                    <div className={styles.itemMeta}>
                      {(getField(s, 'authorType', 'author_type') === 'anonymous' ? t('admin.authorAnonymous') : (getField(s, 'authorName', 'author_name') || t('admin.authorAnonymous'))) as string} · {formatTs(getField(s, 'createdAt', 'created_at') as number | null)}
                    </div>
                  </div>
                  <span className={styles.itemCategory}>{s.category}</span>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <button
                className={`${styles.btnSecondary} ${styles.loadMoreBtn}`}
                onClick={() => fetchSubmissions(nextCursor)}
                disabled={loading}
              >
                {loading ? t('admin.loading') : t('admin.loadMore')}
              </button>
            )}
          </>
        )}
      </main>
    )
  }

  // ── Submission Detail ──

  const authorDisplay = selected.authorType === 'anonymous'
    ? t('admin.authorAnonymous')
    : `${selected.authorName}（${selected.authorType === 'real' ? t('admin.authorReal') : t('admin.authorPenName')}）`

  const statusLabel = STATUS_LABEL_KEYS[selected.status] || selected.status

  return (
    <main className={styles.container}>
      <button className={styles.back} onClick={() => setSelected(null)}>
        {t('admin.back')}
      </button>

      <div className={styles.detailCard}>
        <h2 className={styles.detailTitle}>{selected.title}</h2>

        <div className={styles.detailMeta}>
          <span>{t('admin.category', { category: selected.category })}</span>
          <span>
            {t('admin.authorLabel')}{authorDisplay}
          </span>
          <span>{t('admin.submitTime', { time: formatTs(selected.createdAt ?? selected.created_at ?? null) })}</span>
          <span>{t('admin.status', { status: statusLabel })}</span>
          {selected.submitterGh && <span>GitHub: {selected.submitterGh}</span>}
          {selected.submitterX && <span>X: {selected.submitterX}</span>}
        </div>

        {selected.contact && (
          <div className={styles.detailContact}>
            {t('admin.contact', { contact: selected.contact })}
          </div>
        )}

        <div className={styles.detailContent}>
          {selected.contentRaw}
        </div>

        {selected.reviewNotes && (
          <div className={styles.detailContact}>
            {t('admin.reviewNotes', { notes: selected.reviewNotes })}
            {selected.reviewerGh && t('admin.reviewer', { reviewer: selected.reviewerGh })}
            {selected.reviewedAt && ` · ${formatTs(selected.reviewedAt)}`}
          </div>
        )}

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {selected.status === 'pending' && (
          <>
            <textarea
              className={styles.reviewTextarea}
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder={t('admin.reviewTextareaPlaceholder')}
            />

            <div className={styles.reviewActions}>
              <button className={styles.btnPrimary} onClick={() => handleReview('approved')}>
                {t('admin.approve')}
              </button>
              <button className={styles.btnReject} onClick={() => handleReview('rejected')}>
                {t('admin.reject')}
              </button>
            </div>
          </>
        )}

        {/* Re-review is not supported by the current backend state machine */}
      </div>
    </main>
  )
}
