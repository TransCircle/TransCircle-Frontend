import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/context/AuthContext'
import styles from './Admin.module.css'

const TEMP_TOKEN_KEY = 'tc_temp_admin_token'
const TEMP_TOKEN_EXPIRY_KEY = 'tc_temp_admin_token_exp'
const TEMP_TOKEN_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours

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

const TABS: { key: Status; label: string }[] = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已拒绝' },
]

function getStoredToken(): string {
  try {
    const token = localStorage.getItem(TEMP_TOKEN_KEY) || ''
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

const Admin = () => {
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

      const res = await fetch(`/v1/admin/contributions?${params}`, { headers: authHeaders() })
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

      // Handle both contract format (data array + pagination) and legacy format
      const items = body.data ?? body.submissions ?? []
      const pageCursor = body.pagination?.nextCursor ?? body.nextCursor ?? null

      if (pageCursor) {
        setSubmissions(prev => [...prev, ...items])
      } else {
        setSubmissions(items)
      }
      setNextCursor(pageCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载投稿列表失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, authHeaders])

  useEffect(() => {
    if (user?.isAdmin || tempToken) fetchSubmissions()
  }, [user, tempToken, fetchSubmissions])

  useEffect(() => {
    if (user?.isAdmin || tempToken) fetchSubmissions()
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDetail = async (id: string) => {
    try {
      const res = await fetch(`/v1/admin/contributions/${id}`, { headers: authHeaders() })
      if (!res.ok) throw new Error('加载失败')
      const body = await res.json() as { data?: Submission }
      setSelected(body.data ?? null)
      setReviewNotes('')
    } catch {
      setError('加载投稿详情失败')
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    const v = selected.version || 1
    try {
      const res = await fetch(`/v1/admin/contributions/${selected.id}/review`, {
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
      setError(err instanceof Error ? err.message : '审核操作失败')
    }
  }

  // ── Loading ──

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>验证身份...</div>
      </main>
    )
  }

  // ── Not logged in (no OAuth user + no temp token) ──

  if (!user && !tempToken) {
    const handleTempLogin = () => {
      if (tokenInput.trim()) {
        localStorage.setItem(TEMP_TOKEN_KEY, tokenInput.trim())
        localStorage.setItem(TEMP_TOKEN_EXPIRY_KEY, String(Date.now() + TEMP_TOKEN_MAX_AGE))
        setTempToken(tokenInput.trim())
      }
    }

    return (
      <main className={styles.container}>
        <header style={{ marginBottom: '1rem' }}>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-main)', margin: 0 }}>
            审核后台
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>
            使用 GitHub OAuth 登录，或输入临时管理员令牌
          </p>
        </header>

        <div className={styles.loginBox}>
          <button className={styles.btnPrimary} onClick={loginWithGitHub} style={{ marginBottom: '1.5rem' }}>
            使用 GitHub 登录
          </button>

          <div style={{ borderTop: '1px solid var(--divider-color)', paddingTop: '1.25rem' }}>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '0 0 0.65rem 0' }}>
              或使用临时令牌登录（OAuth 配置完成前的过渡方案）
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="输入临时管理员令牌"
              onKeyDown={(e) => e.key === 'Enter' && handleTempLogin()}
            />
            <button className={styles.btnSecondary} onClick={handleTempLogin}>
              令牌登录
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
        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-main)', margin: 0 }}>
          访问被拒绝
        </h1>
        <p style={{ color: 'var(--text-muted)' }}>
          你的 GitHub 账号 ({user.username}) 不是 TransCircle 组织成员，无权访问审核后台。
        </p>
      </main>
    )
  }

  // ── Submission List ──

  if (!selected) {
    return (
      <main className={styles.container}>
        <div className={styles.bar}>
          <div>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-main)', margin: 0 }}>
              审核后台
            </h1>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {user ? `${user.username} (${user.provider})` : '临时管理员'}
            </span>
          </div>
        </div>

        <nav className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className={styles.count}>共 {submissions.length} 篇{nextCursor ? '+' : ''}</div>

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {loading && submissions.length === 0 ? (
          <div className={styles.loading}>加载中...</div>
        ) : submissions.length === 0 ? (
          <div className={styles.empty}>暂无投稿</div>
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
                      {(getField(s, 'authorType', 'author_type') === 'anonymous' ? '匿名' : (getField(s, 'authorName', 'author_name') || '匿名')) as string} · {formatTs(getField(s, 'createdAt', 'created_at') as number | null)}
                    </div>
                  </div>
                  <span className={styles.itemCategory}>{s.category}</span>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <button
                className={styles.btnSecondary}
                onClick={() => fetchSubmissions(nextCursor)}
                disabled={loading}
                style={{ marginTop: '1rem', width: '100%' }}
              >
                {loading ? '加载中...' : '加载更多'}
              </button>
            )}
          </>
        )}
      </main>
    )
  }

  // ── Submission Detail ──

  return (
    <main className={styles.container}>
      <button className={styles.back} onClick={() => setSelected(null)}>
        ← 返回列表
      </button>

      <div className={styles.detailCard}>
        <h2 className={styles.detailTitle}>{selected.title}</h2>

        <div className={styles.detailMeta}>
          <span>分类：{selected.category}</span>
          <span>
            署名：
            {selected.authorType === 'anonymous'
              ? '匿名'
              : `${selected.authorName}（${selected.authorType === 'real' ? '实名' : '笔名'}）`}
          </span>
          <span>投稿时间：{formatTs(selected.createdAt ?? selected.created_at ?? null)}</span>
          <span>状态：{selected.status === 'pending' ? '待审核' : selected.status === 'approved' ? '已通过' : '已拒绝'}</span>
          {selected.submitterGh && <span>GitHub: {selected.submitterGh}</span>}
          {selected.submitterX && <span>X: {selected.submitterX}</span>}
        </div>

        {selected.contact && (
          <div className={styles.detailContact}>
            联系方式：{selected.contact}
          </div>
        )}

        <div className={styles.detailContent}>
          {selected.contentRaw}
        </div>

        {selected.reviewNotes && (
          <div className={styles.detailContact}>
            审核意见：{selected.reviewNotes}
            {selected.reviewerGh && `（审核人：${selected.reviewerGh}）`}
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
              placeholder="审核意见（选填）..."
            />

            <div className={styles.reviewActions}>
              <button className={styles.btnPrimary} onClick={() => handleReview('approved')}>
                通过
              </button>
              <button className={styles.btnReject} onClick={() => handleReview('rejected')}>
                拒绝
              </button>
            </div>
          </>
        )}

        {/* Re-review is not supported by the current backend state machine */}
      </div>
    </main>
  )
}

export default Admin
