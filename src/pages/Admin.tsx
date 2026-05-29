import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/context/AuthContext'
import styles from './Admin.module.css'

const TEMP_TOKEN_KEY = 'tc_temp_admin_token'

type Status = 'pending' | 'approved' | 'rejected'
type ReviewAction = 'approve' | 'reject' | 'request_changes'

interface Submission {
  id: string
  title: string
  category: string
  author_type: string
  author_name: string | null
  contact: string | null
  content: string
  status: Status
  reviewer_gh: string | null
  review_notes: string | null
  created_at: string
  reviewed_at: string | null
  submitter_gh: string | null
  submitter_x: string | null
}

interface ListResponse {
  submissions: Submission[]
  total: number
}

const TABS: { key: Status; label: string }[] = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已拒绝' },
]

function getStoredToken(): string {
  try {
    return localStorage.getItem(TEMP_TOKEN_KEY) || ''
  } catch { return '' }
}

const Admin = () => {
  const { user, loading: authLoading, loginWithGitHub } = useAuth()
  const [tempToken, setTempToken] = useState(getStoredToken)
  const [tokenInput, setTokenInput] = useState('')
  const [activeTab, setActiveTab] = useState<Status>('pending')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Submission | null>(null)
  const [reviewNotes, setReviewNotes] = useState('')

  const authHeaders = (): Record<string, string> => {
    if (user?.isAdmin) return {} // uses session cookie
    if (tempToken) return { Authorization: `Bearer ${tempToken}` }
    return {}
  }

  const fetchSubmissions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/submissions?status=${activeTab}`, { headers: authHeaders() })
      if (res.status === 403) {
        localStorage.removeItem(TEMP_TOKEN_KEY)
        setTempToken('')
        return
      }
      if (!res.ok) throw new Error('加载失败')
      const data = await res.json() as ListResponse
      setSubmissions(data.submissions)
      setTotal(data.total)
    } catch {
      setError('加载投稿列表失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, tempToken, user])

  useEffect(() => {
    if (user?.isAdmin || tempToken) fetchSubmissions()
  }, [user, tempToken, fetchSubmissions])

  const fetchDetail = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/submissions/${id}`, { headers: authHeaders() })
      if (!res.ok) throw new Error('加载失败')
      setSelected(await res.json() as Submission)
      setReviewNotes('')
    } catch {
      setError('加载投稿详情失败')
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    try {
      const res = await fetch('/api/admin/review', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          id: selected.id,
          action,
          notes: reviewNotes || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? '操作失败')
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

  // ── Not logged in ──

  if (!user) {
    const handleTempLogin = () => {
      if (tokenInput.trim()) {
        localStorage.setItem(TEMP_TOKEN_KEY, tokenInput.trim())
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

  // ── Not admin ──

  if (!user.isAdmin) {
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
              {user.username} ({user.provider})
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

        <div className={styles.count}>共 {total} 篇</div>

        {error && <div className={styles.errorBox}>{error}</div>}

        {loading ? (
          <div className={styles.loading}>加载中...</div>
        ) : submissions.length === 0 ? (
          <div className={styles.empty}>暂无投稿</div>
        ) : (
          <ul className={styles.list}>
            {submissions.map((s) => (
              <li key={s.id} className={styles.item} onClick={() => fetchDetail(s.id)}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{s.title}</div>
                  <div className={styles.itemMeta}>
                    {s.author_type === 'anonymous' ? '匿名' : s.author_name} · {s.created_at.slice(0, 10)}
                  </div>
                </div>
                <span className={styles.itemCategory}>{s.category}</span>
              </li>
            ))}
          </ul>
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
            {selected.author_type === 'anonymous'
              ? '匿名'
              : `${selected.author_name}（${selected.author_type === 'real' ? '实名' : '笔名'}）`}
          </span>
          <span>投稿时间：{selected.created_at.slice(0, 16).replace('T', ' ')}</span>
          <span>状态：{selected.status === 'pending' ? '待审核' : selected.status === 'approved' ? '已通过' : '已拒绝'}</span>
          {selected.submitter_gh && <span>GitHub: {selected.submitter_gh}</span>}
          {selected.submitter_x && <span>X: {selected.submitter_x}</span>}
        </div>

        {selected.contact && (
          <div className={styles.detailContact}>
            联系方式：{selected.contact}
          </div>
        )}

        <div className={styles.detailContent}>
          {selected.content}
        </div>

        {selected.review_notes && (
          <div className={styles.detailContact}>
            审核意见：{selected.review_notes}
            {selected.reviewer_gh && `（审核人：${selected.reviewer_gh}）`}
            {selected.reviewed_at && ` · ${selected.reviewed_at.slice(0, 16).replace('T', ' ')}`}
          </div>
        )}

        {error && <div className={styles.errorBox}>{error}</div>}

        {selected.status === 'pending' && (
          <>
            <textarea
              className={styles.reviewTextarea}
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder="审核意见（选填）..."
            />

            <div className={styles.reviewActions}>
              <button className={styles.btnPrimary} onClick={() => handleReview('approve')}>
                通过
              </button>
              <button className={styles.btnSecondary} onClick={() => handleReview('request_changes')}>
                要求修改
              </button>
              <button className={styles.btnReject} onClick={() => handleReview('reject')}>
                拒绝
              </button>
            </div>
          </>
        )}

        {selected.status !== 'pending' && (
          <button
            className={styles.btnSecondary}
            onClick={() => handleReview('approve')}
            style={{ marginTop: '0.5rem' }}
          >
            重新审核为通过
          </button>
        )}
      </div>
    </main>
  )
}

export default Admin
