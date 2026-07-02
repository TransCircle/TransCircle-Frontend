import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import {
  AdminButton,
  Alert,
  EmptyState,
  Spinner,
  StatusBadge,
  Tabs,
  CONTRIB_STATUS_TONE,
  type TabItem,
} from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import shell from './Page.module.css'

interface MyContribution {
  id: string
  title: string
  status: string
  createdAt: number
  updatedAt: number
  review: {
    publicNote: string | null
    reviewedAt: number | null
  }
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'myContributions.filterDraft',
  pending: 'myContributions.filterPending',
  in_review: 'myContributions.filterInReview',
  approved: 'myContributions.filterApproved',
  rejected: 'myContributions.filterRejected',
  published: 'myContributions.filterPublished',
  hidden: 'myContributions.filterHidden',
  withdrawn: 'myContributions.filterWithdrawn',
}

const FILTERS = [
  'all',
  'draft',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'published',
  'hidden',
  'withdrawn',
] as const

const ChevronIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export const MyContributions = () => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { t } = useTranslation()
  const formatTs = useFormatTs()

  const [items, setItems] = useState<MyContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const fetchSeq = useRef(0)

  const fetchList = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      // api.md §4.1: status param is optional, defaults to all statuses when omitted
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus)
      if (cursorVal) params.set('cursor', cursorVal)

      const result = await get<MyContribution[]>(`/me/contributions?${params}`)
      if (seq !== fetchSeq.current) return // Stale response, discard
      if (!result.ok) throw new Error(result.error.message)

      if (cursorVal) {
        setItems((prev) => [...prev, ...result.data])
      } else {
        setItems(result.data)
      }
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      if (seq !== fetchSeq.current) return // Stale response, discard
      setError(err instanceof Error ? err.message : t('myContributions.error'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!user) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems([])
    setCursor(null)
    fetchList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filterStatus])

  if (!user) {
    return (
      <div className={shell.page}>
        <EmptyState title={t('myContributions.loginRequired')} />
      </div>
    )
  }

  const tabs: TabItem[] = FILTERS.map((s) => ({
    key: s,
    label: s === 'all' ? t('myContributions.filterAll') : t(STATUS_LABEL_KEYS[s]!),
  }))

  return (
    <div className={shell.page}>
      <div className={shell.head}>
        <Tabs
          items={tabs}
          value={filterStatus}
          onChange={setFilterStatus}
          ariaLabel={t('myContributions.title')}
          panelId="my-contributions-panel"
        />
      </div>

      <div
        id="my-contributions-panel"
        role="tabpanel"
        aria-labelledby={`tab-${filterStatus}`}
        className={shell.tabpanel}
      >
        {error && <Alert tone="error">{error}</Alert>}

        {loading && items.length === 0 ? (
          <Spinner size="lg" label={t('myContributions.loading')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('myContributions.empty')} />
        ) : (
          <>
            <ul className={shell.list}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={shell.rowBtn}
                    onClick={() => navigate(`/me/contributions/${item.id}`)}
                  >
                    <span className={shell.rowMain}>
                      <span className={shell.rowTitle}>{item.title}</span>
                      <span className={shell.rowMeta}>
                        {formatTs(item.createdAt)}
                        {item.review.publicNote && (
                          <>
                            <span className={shell.rowMetaSep}>·</span>
                            {item.review.publicNote}
                          </>
                        )}
                      </span>
                    </span>
                    <span className={shell.rowRight}>
                      <StatusBadge
                        tone={CONTRIB_STATUS_TONE[item.status] ?? 'neutral'}
                        label={STATUS_LABEL_KEYS[item.status] ? t(STATUS_LABEL_KEYS[item.status]!) : item.status}
                        size="sm"
                      />
                      <span className={shell.chevron} aria-hidden="true">
                        <ChevronIcon />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {cursor && (
              <div className={shell.loadMoreWrap}>
                <AdminButton variant="secondary" loading={loading} onClick={() => fetchList(cursor)}>
                  {t('myContributions.loadMore')}
                </AdminButton>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
