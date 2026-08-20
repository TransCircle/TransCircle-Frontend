import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList } from '@/hooks/usePagedList'
import {
  Alert,
  CONTRIB_STATUS_TONE,
  EmptyState,
  PageHeader,
  Pagination,
  Skeleton,
  StatusBadge,
  Tabs,
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

  const [filterStatus, setFilterStatus] = useState('all')

  // 游标分页列表（统一模板）：切 tab（filterStatus 变化）自动重载，保留旧列表 + 加载条
  const { items, pageIndex, knownPages, hasMore, loading, error, goToPage } = usePagedList<MyContribution>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '20' })
      // api.md §4.1: status param is optional, defaults to all statuses when omitted
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus)
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<MyContribution[]>(`/me/contributions?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [user, filterStatus],
  })

  const tabs: TabItem[] = FILTERS.map((s) => ({
    key: s,
    label: s === 'all' ? t('myContributions.filterAll') : t(STATUS_LABEL_KEYS[s]!),
  }))

  return (
    <div className={shell.page}>
      <div className={shell.head}>
        <PageHeader title={t('myContributions.title')} size="section" as="h1" />
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
          <Skeleton rows={6} />
        ) : items.length === 0 ? (
          <EmptyState title={t('myContributions.empty')} />
        ) : (
          <>
            {/* 已有内容时切 tab/刷新：保留旧列表，顶部显示轻量加载条，避免清空闪烁 */}
            {loading && (
              <div className={shell.loadingBar} role="status" aria-live="polite">
                {t('myContributions.loading')}
              </div>
            )}
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
            <Pagination
              pageIndex={pageIndex}
              knownPages={knownPages}
              hasMore={hasMore}
              disabled={loading}
              onChange={goToPage}
            />
          </>
        )}
      </div>
    </div>
  )
}
