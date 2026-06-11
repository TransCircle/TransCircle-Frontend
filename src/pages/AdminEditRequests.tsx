import { useState, useEffect } from 'react'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

interface EditRequestItem {
  id: string
  status: string
  version: number
  reason: string
  requesterId: string
  // Nested structure (api.md §10.5)
  contribution?: {
    id: string
    title: string
  }
  proposed?: {
    title?: string | null
    summary?: string | null
    content?: string | null
    tags?: string[] | null
  } | null
  votes?: {
    approve: number
    reject: number
    total: number
    required: number
  }
  myVote?: string | null
  // Legacy flat fields for backward compat during migration
  contributionId?: string
  proposedTitle?: string | null
  proposedContent?: string | null
  proposedSummary?: string | null
  proposedTags?: string[] | null
  createdAt: number
  updatedAt: number
}

interface VoteResult {
  id: string
  editRequestId: string
  reviewerUserId: string
  vote: string
  note: string | null
  createdAt: number
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const AdminEditRequests = () => {
  const { accessToken } = useAuth()

  const [items, setItems] = useState<EditRequestItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EditRequestItem | null>(null)
  const [votes, setVotes] = useState<VoteResult[]>([])
  const [voteSubmitting, setVoteSubmitting] = useState(false)
  const [voteNote, setVoteNote] = useState('')

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

  const fetchList = async (cursorVal?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20', status: 'pending' })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<EditRequestItem[]>(`/admin/edit-requests?${params}`, {
        headers: authHeaders(), skipRefresh: true,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setItems(prev => [...prev, ...result.data])
      else setItems(result.data)
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchList() }, [])

  const fetchDetail = async (id: string) => {
    setSelectedId(id)
    setVoteNote('')
    const result = await get<EditRequestItem>(`/admin/edit-requests/${id}`, {
      headers: authHeaders(), skipRefresh: true,
    })
    if (result.ok) setDetail(result.data)
    else setError(result.error.message)
  }

  const handleVote = async (vote: 'approve' | 'reject') => {
    if (!selectedId || !detail) return
    setVoteSubmitting(true)
    setError('')
    const result = await post(`/admin/edit-requests/${selectedId}/vote`, {
      vote,
      note: voteNote.trim() || null,
      expectedVersion: detail.version,
    }, { headers: authHeaders(), skipRefresh: true })
    setVoteSubmitting(false)
    if (result.ok) {
      setVoteNote('')
      fetchDetail(selectedId)
    } else {
      setError(result.error.message)
    }
  }

  if (selectedId && detail) {
    return (
      <main className={styles.container}>
        <button className={styles.back} onClick={() => { setSelectedId(null); setDetail(null); setVotes([]) }}>
          ← 返回列表
        </button>
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>修改申请详情</h2>
          <div className={styles.detailMeta}>
            <span>投稿 ID: {detail.contribution?.id ?? detail.contributionId ?? '—'}</span>
            <span>状态: {detail.status}</span>
            <span>版本: v{detail.version}</span>
            <span>创建: {formatTs(detail.createdAt)}</span>
          </div>
          <div className={styles.detailContent}><strong>原因：</strong>{detail.reason}</div>

          {/* Votes progress */}
          {detail.votes && (
            <div style={{ margin: '1rem 0', padding: '0.75rem', background: 'var(--hover-bg)', borderRadius: '8px' }}>
              <strong>投票进度：</strong>
              赞成 {detail.votes.approve} · 反对 {detail.votes.reject}
              · 总票数 {detail.votes.total} · 需要 {detail.votes.required} 票
              {detail.myVote && <span> · 我的投票：{detail.myVote === 'approve' ? '赞成' : '反对'}</span>}
            </div>
          )}

          {/* Proposed changes — prefer nested fields, fall back to flat */}
          {(detail.proposed?.title ?? (detail as unknown as Record<string, string | null>).proposedTitle) && (
            <p><strong>建议新标题：</strong>{detail.proposed?.title ?? (detail as unknown as Record<string, string | null>).proposedTitle}</p>
          )}
          {(detail.proposed?.summary ?? (detail as unknown as Record<string, string | null>).proposedSummary) && (
            <p><strong>建议新摘要：</strong>{detail.proposed?.summary ?? (detail as unknown as Record<string, string | null>).proposedSummary}</p>
          )}
          {(detail.proposed?.content ?? (detail as unknown as Record<string, string | null>).proposedContent) && (
            <div className={styles.detailContent}>
              <strong>建议新内容：</strong>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                {detail.proposed?.content ?? (detail as unknown as Record<string, string | null>).proposedContent}
              </pre>
            </div>
          )}
          {(detail.proposed?.tags ?? (detail as unknown as Record<string, string[] | null>).proposedTags) && (
            <p><strong>建议新标签：</strong>{(detail.proposed?.tags ?? (detail as unknown as Record<string, string[] | null>).proposedTags)!.join(', ')}</p>
          )}

          {error && <div className={styles.errorBox}>{error}</div>}

          {detail.status === 'pending' && (
            <>
              <textarea className={styles.reviewTextarea} value={voteNote}
                onChange={e => setVoteNote(e.target.value)} placeholder="投票备注（选填）" />
              <div className={styles.reviewActions}>
                <button className={styles.btnPrimary} onClick={() => handleVote('approve')} disabled={voteSubmitting}>
                  {voteSubmitting ? '提交中...' : '赞成'}
                </button>
                <button className={styles.btnReject} onClick={() => handleVote('reject')} disabled={voteSubmitting}>
                  {voteSubmitting ? '提交中...' : '反对'}
                </button>
              </div>
            </>
          )}

          {votes.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <strong>投票记录</strong>
              <ul style={{ margin: '0.5rem 0 0', padding: '0 0 0 1.2rem', fontSize: '0.85rem', lineHeight: 1.8 }}>
                {votes.map(v => (
                  <li key={v.id}>{v.vote === 'approve' ? '✅' : '❌'} {v.vote} · {v.note || '无备注'} · {formatTs(v.createdAt)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header><h1 className={styles.heading}>编辑申请审核</h1></header>
      {error && <div className={styles.errorBox}>{error}</div>}
      {loading && items.length === 0 ? (
        <div className={styles.loading}>加载中...</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>暂无待处理的编辑申请</div>
      ) : (
        <ul className={styles.list}>
          {items.map(item => (
            <li key={item.id} className={styles.item} role="button" tabIndex={0}
              onClick={() => fetchDetail(item.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fetchDetail(item.id) } }}>
              <div className={styles.itemMain}>
                <div className={styles.itemTitle}>投稿 {(item.contribution?.id ?? item.contributionId ?? '').slice(0, 20)}... · {item.status}</div>
                <div className={styles.itemMeta}>{item.reason.slice(0, 60)} · {formatTs(item.createdAt)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button className={styles.btnSecondary} onClick={() => fetchList(cursor)}
          disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
          加载更多
        </button>
      )}
    </main>
  )
}
