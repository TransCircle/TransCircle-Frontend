import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get } from '@/api/client'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { useFormatTs } from '@/utils/datetime'
import { ellipsize } from '@/utils/string'
import {
  AdminButton,
  Alert,
  EmptyState,
  Pill,
  SearchField,
  Skeleton,
  StatusBadge,
  Tabs,
  CONTRIB_STATUS_TONE,
  type TabItem,
} from '@/components/admin'
import { ChevronRightIcon, Pagination, Select } from '@/components/ui'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import { useAdminChange } from './changes'
import { useListHref, useListParams, useReturnFocus, type RowLinkState } from './listParams'
import {
  ANY_STATUS_LABEL_KEYS,
  CONTRIBUTION_PAGE_SIZE,
  MANAGE_SORTS,
  MANAGE_STATUSES,
  REVIEW_SORTS,
  readQuery,
  toApiParams,
  type ContributionListSection,
  type Submission,
} from './contributions'

/** 关键词输入停顿多久后生效（同搜索页的即时搜索）。 */
const KEYWORD_DEBOUNCE_MS = 400

type Row = Submission & { ageMs: number }

const STATUS_TAB_KEYS: Record<string, string> = {
  pending: 'admin.statusPending',
  in_review: 'admin.statusInReview',
  approved: 'admin.statusApproved',
  rejected: 'admin.statusRejected',
  published: 'admin.statusPublished',
  hidden: 'admin.statusHidden',
  all: 'adminContributions.statusAll',
}

const SORT_LABEL_KEYS: Record<string, string> = {
  submittedAt_asc: 'adminContributions.sortSubmittedOldest',
  submittedAt_desc: 'adminContributions.sortSubmittedNewest',
  createdAt_asc: 'adminContributions.sortOldest',
  createdAt_desc: 'adminContributions.sortNewest',
  updatedAt_desc: 'adminContributions.sortUpdated',
}

/**
 * 投稿列表：审核队列与投稿管理共用。
 *
 * - 审核队列（/admin/review）：只有待审核，默认按创建时间最早优先——它是工作入口；
 * - 投稿管理（/admin/contributions）：全部状态 + 关键词 + 作者筛选 + 排序，用来找到并处置已有内容。
 *
 * 筛选、排序、页码都在 URL 里；点一行是真正的链接，进入 /admin/contributions/:id。
 */
function ContributionList({ section }: { section: ContributionListSection }) {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { loading: authLoading, permissions } = useAuth()
  const ready = !authLoading && hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  const { searchParams, patch, page: urlPage, setPage } = useListParams()
  const query = readQuery(section, searchParams)
  const queryKey = `${query.status}|${query.sort}|${query.keyword}|${query.authorId}`
  const isQueue = section === 'review'

  const { items, page, total, totalPages, stale, staleResults, loading, error, refresh } = usePagedList<Row>({
    fetchPage: async (targetPage) => {
      // 不传 authHeaders / skipRefresh：apiRequest 自动注入 Authorization 并处理 401 刷新
      const result = await get<Submission[]>(`/admin/contributions?${toApiParams(query, targetPage)}`)
      // 403/401：权限变更后快照过期
      if (result.status === 403 || result.status === 401) throw new Error(t('admin.accessDenied'))
      if (!result.ok) throw new Error(result.error.message || t('admin.errorLoad'))
      // 等待时长在数据到达时算一次：渲染期间读时钟会让同一份数据每次渲染都不一样。
      // 从最近一次提交算起（被拒后重新提交的从重新提交算）；没有提交时间的旧数据退回创建时间
      const now = Date.now()
      const rows = result.data.map((s) => ({ ...s, ageMs: Math.max(0, now - (s.submittedAt ?? s.createdAt)) }))
      return toPagedResult(rows, result.pagination)
    },
    deps: [queryKey, ready],
    autoLoad: ready,
    page: urlPage,
    // 越界页被服务端回落时，把实际页码写回 URL
    onPageMismatch: setPage,
  })
  useReturnFocus(!loading && items.length > 0)
  // 别处（详情页）写成功了某条投稿：就地重取当前页
  useAdminChange((change) => {
    if (change.kind === 'contribution' && ready) void refresh()
  })
  const from = useListHref()

  useAdminPageHeader({
    title: t(isQueue ? 'adminQueue.title' : 'adminContributions.title'),
    subtitle: t(isQueue ? 'adminQueue.subtitle' : 'adminContributions.subtitle'),
  })

  /* ── 关键词：输入停顿后写进 URL（replace）；前进 / 后退等外部变化回填输入框 ── */
  const [keywordInput, setKeywordInput] = useState(query.keyword)
  const lastPushedRef = useRef(query.keyword)
  useEffect(() => {
    if (query.keyword === lastPushedRef.current) return
    lastPushedRef.current = query.keyword
    setKeywordInput(query.keyword)
  }, [query.keyword])
  useEffect(() => {
    const next = keywordInput.trim()
    if (next === query.keyword) return
    const timer = window.setTimeout(() => {
      lastPushedRef.current = next
      patch({ q: next || null })
    }, KEYWORD_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [keywordInput, query.keyword, patch])
  const applyKeyword = (value: string) => {
    // 条件没变（如加载失败后再回车）：URL 不会变，直接重取
    if (value === query.keyword) {
      void refresh()
      return
    }
    lastPushedRef.current = value
    patch({ q: value || null })
  }

  const tabs: Array<TabItem<string>> = MANAGE_STATUSES.map((s) => ({ key: s, label: t(STATUS_TAB_KEYS[s] ?? s) }))
  const sorts: readonly string[] = isQueue ? REVIEW_SORTS : MANAGE_SORTS
  const panelId = `${section}-panel`

  const authorName =
    query.authorId &&
    (items.find((i) => i.author?.id === query.authorId)?.author.displayName || ellipsize(query.authorId, 12))
  const filtered = !!(query.keyword || query.authorId)

  /* 首个响应还没回来（冷启动）、或屏幕上这批已经不属于当前筛选（切换后请求失败）
     时不显示数量：前者会先宣称「共 0 篇」再跳成真实值，后者报的是上一个筛选的数。 */
  const countKnown = !(loading && items.length === 0) && !staleResults

  const ageLabel = (ms: number) => {
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return t('adminQueue.waitMinutes', { count: Math.max(1, minutes) })
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return t('adminQueue.waitHours', { count: hours })
    return t('adminQueue.waitDays', { count: Math.floor(hours / 24) })
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        {isQueue ? (
          /* 审核队列只放待审核：后端没有任何流程会把投稿置为「审核中」（历史数据仍可在投稿管理里查看），
             所以这里不再给一个永远为空的选项卡；左侧换成一句队列规则，排序在右。 */
          <div className={shell.headRow}>
            <p className={shell.headNote}>{t('adminQueue.rule')}</p>
            <Select<string>
              value={query.sort}
              onChange={(sort) => patch({ sort })}
              ariaLabel={t('adminContributions.sortLabel')}
              fieldClassName={shell.headSort}
              options={sorts.map((s) => ({ value: s, label: t(SORT_LABEL_KEYS[s] ?? s) }))}
            />
          </div>
        ) : (
          <>
            <Tabs
              items={tabs}
              value={query.status}
              onChange={(status) => patch({ status })}
              ariaLabel={t('adminContributions.tabsAriaLabel')}
              panelId={panelId}
            />
            <div className={shell.toolbar}>
              <SearchField
                value={keywordInput}
                onValueChange={setKeywordInput}
                onSearch={() => applyKeyword(keywordInput.trim())}
                onClear={() => {
                  setKeywordInput('')
                  applyKeyword('')
                }}
                placeholder={t('adminContributions.searchPlaceholder')}
                searchAriaLabel={t('adminContributions.searchPlaceholder')}
                clearAriaLabel={t('admin.ui.clear')}
                fieldClassName={shell.grow}
              />
              <Select<string>
                value={query.sort}
                onChange={(sort) => patch({ sort })}
                ariaLabel={t('adminContributions.sortLabel')}
                fieldClassName={shell.filter}
                options={sorts.map((s) => ({ value: s, label: t(SORT_LABEL_KEYS[s] ?? s) }))}
              />
            </div>
            {/* 已生效的筛选条件单独一行（不和搜索框、排序挤在同一行里冒充控件），一眼看出「现在只看谁的稿」 */}
            {query.authorId && (
              <div className={shell.activeFilters}>
                <span className={shell.activeFiltersLabel}>{t('adminContributions.activeFilters')}</span>
                <span className={shell.chip}>
                  <span className={shell.chipText}>
                    <span className={shell.chipKey}>{t('adminContributions.author')}</span>
                    {authorName}
                  </span>
                  <button
                    type="button"
                    className={shell.chipRemove}
                    onClick={() => patch({ author: null })}
                    aria-label={t('adminContributions.authorChipRemove', { name: authorName })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div
        id={panelId}
        role={isQueue ? undefined : 'tabpanel'}
        aria-labelledby={isQueue ? undefined : `tab-${query.status}`}
        className={shell.tabpanel}
      >
        <div className={shell.count} role="status" aria-live="polite">
          {countKnown ? t('admin.count', { count: total }) : null}
        </div>

        {error && (
          <Alert tone="error">
            <span className={shell.errorRow}>
              {error}
              <AdminButton variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
                {t('common.retry')}
              </AdminButton>
            </span>
          </Alert>
        )}

        {loading && items.length === 0 ? (
          <Skeleton rows={7} />
        ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
           不能再把它们摆出来——行还是可点的，点进去会处置一个不属于本视图的条目。 */
        staleResults ? (
          // 已确认不属于当前条件的旧行不再摆出来；重试在途时只给加载提示
          loading ? (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('admin.loading')}
            </div>
          ) : null
        ) : items.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? t('adminContributions.emptyFiltered')
                : isQueue
                  ? t('adminQueue.empty', { status: t(STATUS_TAB_KEYS[query.status] ?? query.status) })
                  : t('adminContributions.empty', { status: t(STATUS_TAB_KEYS[query.status] ?? query.status) })
            }
            description={isQueue && !filtered ? t('adminQueue.emptyDescription') : undefined}
            action={
              filtered ? (
                <AdminButton
                  variant="secondary"
                  onClick={() => {
                    setKeywordInput('')
                    lastPushedRef.current = ''
                    patch({ q: null, author: null })
                  }}
                >
                  {t('adminContributions.clearFilters')}
                </AdminButton>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* 切换筛选 / 翻页：保留旧列表，顶部轻量加载条，避免旧数据无提示被误读 */}
            {loading && (
              <div className={shell.loadingBar} role="status" aria-live="polite">
                {t('admin.loading')}
              </div>
            )}
            <ul className={shell.list}>
              {items.map((s, index) => (
                <li key={s.id}>
                  <Link
                    to={`/admin/contributions/${encodeURIComponent(s.id)}`}
                    state={{ from, index } satisfies RowLinkState}
                    data-row-id={s.id}
                    className={shell.rowBtn}
                  >
                    <span className={shell.rowMain}>
                      <span className={shell.rowTitle}>{s.title}</span>
                      <span className={shell.rowMeta}>
                        {s.author?.displayName || t('admin.authorAnonymous')}
                        <span className={shell.rowMetaSep} aria-hidden="true">
                          ·
                        </span>
                        {/* 队列按提交时间排队，行上的时间与「等待 N 天」同源；管理列表仍显示创建时间 */}
                        {formatTs(isQueue ? (s.submittedAt ?? s.createdAt) : s.createdAt)}
                      </span>
                    </span>
                    <span className={shell.rowRight}>
                      {isQueue && <Pill>{ageLabel(s.ageMs)}</Pill>}
                      {!isQueue && s.pinnedAt && <Pill>{t('admin.pinnedBadge')}</Pill>}
                      <StatusBadge
                        tone={CONTRIB_STATUS_TONE[s.status] ?? 'neutral'}
                        label={t(ANY_STATUS_LABEL_KEYS[s.status] ?? s.status)}
                        size="sm"
                      />
                      <span className={shell.chevron} aria-hidden="true">
                        <ChevronRightIcon />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空（并发处置、状态变更），
            读者仍需要能退回上一页。控件本身在只有一页时会自行隐藏。 */}
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={CONTRIBUTION_PAGE_SIZE}
          disabled={loading || stale}
          onChange={setPage}
        />
      </div>
    </div>
  )
}

export const AdminReviewQueue = () => <ContributionList section="review" />
export const AdminContributions = () => <ContributionList section="contributions" />
