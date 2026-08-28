import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import {
  Alert,
  EmptyState,
  Pagination,
  Skeleton,
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

const PAGE_SIZE = 20

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

  // 页码分页列表（统一模板）：切 tab（filterStatus 变化）自动回到第 1 页，保留旧列表 + 加载条
  const { items, page, total, totalPages, loading, error, goToPage } = usePagedList<MyContribution>({
    fetchPage: async (targetPage) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
      // api.md §4.1: status param is optional, defaults to all statuses when omitted
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus)
      const result = await get<MyContribution[]>(`/me/contributions?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return toPagedResult(result.data, result.pagination)
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
              page={page}
              totalPages={totalPages}
              total={total}
              pageSize={PAGE_SIZE}
              disabled={loading}
              onChange={goToPage}
            />
          </>
        )}
      </div>
    </div>
  )
}
