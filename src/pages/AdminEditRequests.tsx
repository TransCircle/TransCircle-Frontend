import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { limitByUnicode } from '@/utils/string'
import styles from './Admin.module.css'

interface EditRequestItem {
  id: string
  status: string
  version: number
  reason: string
  requester: {
    id: string
    displayName: string
  }
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
    history?: Array<{
      vote: string
      note: string | null
      reviewerId: string
      createdAt: number
    }>
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

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Safely read a proposed-change field, preferring the typed `proposed` sub-object
 * and falling back to the legacy flat field.  Type-safe alternative to
 * `as unknown as Record` (H1).
 */
function getProposedField(
  detail: EditRequestItem | null,
  nestedKey: keyof NonNullable<EditRequestItem['proposed']>,
  flatKey: string,
): string | null | undefined {
  if (!detail) return undefined
  const nested = detail.proposed?.[nestedKey]
  // nested can be string or string[] — only return string values here
  if (typeof nested === 'string') return nested
  if (nested === null) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (detail as any)[flatKey]
}

function getProposedFieldArray(
  detail: EditRequestItem | null,
  nestedKey: keyof NonNullable<EditRequestItem['proposed']>,
  flatKey: string,
): string[] | null | undefined {
  if (!detail) return undefined
  const nested = detail.proposed?.[nestedKey]
  if (Array.isArray(nested)) return nested
  if (nested === null) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (detail as any)[flatKey]
}

export const AdminEditRequests = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, user, isAdmin, permissions } = useAuth()
  const loadedRef = useRef(false)
  const fetchSeq = useRef(0)

  const [items, setItems] = useState<EditRequestItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EditRequestItem | null>(null)
  const [voteSubmitting, setVoteSubmitting] = useState(false)
  const [voteNote, setVoteNote] = useState('')

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

  const fetchList = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20', status: 'pending' })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<EditRequestItem[]>(`/admin/edit-requests?${params}`, {
        headers: authHeaders(), skipRefresh: !accessToken,
      })
      if (seq !== fetchSeq.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setItems(prev => [...prev, ...result.data])
      else setItems(result.data)
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminEditRequests.loadError'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (authLoading || !accessToken) return
    if (loadedRef.current) return
    loadedRef.current = true
    fetchList()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  const fetchDetail = async (id: string) => {
    setSelectedId(id)
    setVoteNote('')
    const result = await get<EditRequestItem>(`/admin/edit-requests/${id}`, {
      headers: authHeaders(), skipRefresh: !accessToken,
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
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    setVoteSubmitting(false)
    if (result.ok) {
      setVoteNote('')
      fetchDetail(selectedId)
    } else {
      setError(result.error.message)
    }
  }

  if (!authLoading && (!user || !isAdmin)) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('adminEditRequests.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('adminEditRequests.accessDeniedDetail')}</p>
      </main>
    )
  }

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('adminEditRequests.loading')}</div>
      </main>
    )
  }

  if (selectedId && detail) {
    return (
      <main className={styles.container}>
        <button className={styles.back} onClick={() => { setSelectedId(null); setDetail(null) }}>
          {t('adminEditRequests.backToList')}
        </button>
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>{t('adminEditRequests.detailTitle')}</h2>
          <div className={styles.detailMeta}>
            <span>{t('adminEditRequests.contributionId')}: {detail.contribution?.id ?? detail.contributionId ?? '—'}</span>
            <span>{t('adminEditRequests.status')}: {detail.status}</span>
            <span>{t('adminEditRequests.version')}: v{detail.version}</span>
            <span>{t('adminEditRequests.created')}: {formatTs(detail.createdAt)}</span>
          </div>
          <div className={styles.detailContent}><strong>{t('adminEditRequests.reason')}：</strong>{detail.reason}</div>

          {/* Votes progress */}
          {detail.votes && (
            <div style={{ margin: '1rem 0', padding: '0.75rem', background: 'var(--hover-bg)', borderRadius: '8px' }}>
              <strong>{t('adminEditRequests.voteProgress')}：</strong>
              {t('adminEditRequests.voteApprove')} {detail.votes.approve} · {t('adminEditRequests.voteReject')} {detail.votes.reject}
              · {t('adminEditRequests.votesTotal')} {detail.votes.total} · {t('adminEditRequests.votesRequired')} {detail.votes.required} 票
              {detail.myVote && <span> · {t('adminEditRequests.myVote')}：{detail.myVote === 'approve' ? t('adminEditRequests.voteApprove') : t('adminEditRequests.voteReject')}</span>}
            </div>
          )}

          {/* Proposed changes — prefer nested fields, fall back to flat (via type guard, H1) */}
          {getProposedField(detail, 'title', 'proposedTitle') && (
            <p><strong>{t('adminEditRequests.proposedTitle')}：</strong>{getProposedField(detail, 'title', 'proposedTitle')}</p>
          )}
          {getProposedField(detail, 'summary', 'proposedSummary') && (
            <p><strong>{t('adminEditRequests.proposedSummary')}：</strong>{getProposedField(detail, 'summary', 'proposedSummary')}</p>
          )}
          {getProposedField(detail, 'content', 'proposedContent') && (
            <div className={styles.detailContent}>
              <strong>{t('adminEditRequests.proposedContent')}：</strong>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                {getProposedField(detail, 'content', 'proposedContent')}
              </pre>
            </div>
          )}
          {getProposedFieldArray(detail, 'tags', 'proposedTags') && (
            <p><strong>{t('adminEditRequests.proposedTags')}：</strong>{(getProposedFieldArray(detail, 'tags', 'proposedTags') ?? []).join(', ')}</p>
          )}

          {error && <div className={styles.errorBox}>{error}</div>}

          {detail.status === 'pending' && hasPermission(permissions, PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE) && (
            <>
              <textarea className={styles.reviewTextarea} value={voteNote}
                onChange={e => setVoteNote(e.target.value)} placeholder={t('adminEditRequests.voteNotePlaceholder')} />
              <div className={styles.reviewActions}>
                <button className={styles.btnPrimary} onClick={() => handleVote('approve')} disabled={voteSubmitting}>
                  {voteSubmitting ? t('adminEditRequests.voteSubmitting') : t('adminEditRequests.voteApprove')}
                </button>
                <button className={styles.btnReject} onClick={() => handleVote('reject')} disabled={voteSubmitting}>
                  {voteSubmitting ? t('adminEditRequests.voteSubmitting') : t('adminEditRequests.voteReject')}
                </button>
              </div>
            </>
          )}

          {detail.votes?.history && detail.votes.history.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <strong>{t('adminEditRequests.voteHistory')}</strong>
              <ul style={{ margin: '0.5rem 0 0', padding: '0 0 0 1.2rem', fontSize: '0.85rem', lineHeight: 1.8 }}>
                {detail.votes.history.map(v => (
                  <li key={v.reviewerId}>{v.vote === 'approve' ? '✅' : '❌'} {v.vote} · {v.note || t('adminEditRequests.noNote')} · {formatTs(v.createdAt)}</li>
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
      <header><h1 className={styles.heading}>{t('adminEditRequests.title')}</h1></header>
      {error && <div className={styles.errorBox}>{error}</div>}
      {loading && items.length === 0 ? (
        <div className={styles.loading}>{t('adminEditRequests.loading')}</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>{t('adminEditRequests.empty')}</div>
      ) : (
        <ul className={styles.list}>
          {items.map(item => (
            <li key={item.id}>
              <button
                type="button"
                className={styles.itemButton}
                onClick={() => fetchDetail(item.id)}
              >
              <div className={styles.itemMain}>
                <div className={styles.itemTitle}>{t('adminEditRequests.contribPrefix')} {limitByUnicode(item.contribution?.id ?? item.contributionId ?? '', 20)}... · {item.status}</div>
                <div className={styles.itemMeta}>{limitByUnicode(item.reason, 60)} · {formatTs(item.createdAt)}</div>
              </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button className={styles.btnSecondary} onClick={() => fetchList(cursor)}
          disabled={loading} style={{ display: 'block', margin: '1rem auto' }}>
          {t('adminEditRequests.loadMore')}
        </button>
      )}
    </main>
  )
}
