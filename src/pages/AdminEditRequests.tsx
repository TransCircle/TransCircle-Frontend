import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { ellipsize } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  EmptyState,
  Skeleton,
  StatusBadge,
  Tabs,
  EDIT_REQUEST_STATUS_TONE,
  EDIT_REQUEST_STATUS_LABEL_KEYS,
  type TabItem,
} from '@/components/admin'
import { ChevronRightIcon, Pagination } from '@/components/ui'
import shell from './Page.module.css'
import { useAdminPageHeader } from './admin/header'
import { useAdminChange } from './admin/changes'
import { useListHref, useListParams, useReturnFocus, type RowLinkState } from './admin/listParams'
import type { EditRequestItem } from './admin/editRequests'

const PAGE_SIZE = 20

/* 状态筛选只放后端真会产生的状态（routes/admin.ts 投票决议与删除投稿、me.ts 撤回）：进行中 / 已通过（已自动应用）/
   已拒绝 / 已撤回 / 已失效（原投稿被删除）。契约里的 applied 当前没有任何流程会写入，不做成永远为空的选项卡。 */
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn', 'superseded'] as const

/** 修改申请列表（/admin/edit-requests?status=）。点一行进入 /admin/edit-requests/:id。 */
export const AdminEditRequests = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading } = useAuth()
  const { searchParams, patch, page: urlPage, setPage } = useListParams()
  const rawStatus = searchParams.get('status')
  const statusFilter = rawStatus && (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : 'pending'
  const ready = !authLoading && !!accessToken

  // 页码分页列表（统一模板）：切 tab（statusFilter 变化）自动重载，保留旧列表 + 加载条
  const { items, page, total, totalPages, stale, staleResults, loading, error, refresh } =
    usePagedList<EditRequestItem>({
      fetchPage: async (targetPage) => {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          page: String(targetPage),
          // 「待处理」含存量的 in_review（后端同样可投票），否则这些申请在网站上找不到
          status: statusFilter === 'pending' ? 'pending,in_review' : statusFilter,
        })
        // apiRequest 自动注入 Authorization 并处理 401 刷新
        const result = await get<EditRequestItem[]>(`/admin/edit-requests?${params}`)
        if (!result.ok) throw new Error(result.error.message)
        return toPagedResult(result.data, result.pagination)
      },
      deps: [ready, statusFilter],
      autoLoad: ready,
      page: urlPage,
      // 越界页被服务端回落时，把实际页码写回 URL
      onPageMismatch: setPage,
    })
  useReturnFocus(!loading && items.length > 0)
  // 别处（详情页）投票成功：就地重取当前页
  useAdminChange((change) => {
    if (change.kind === 'editRequest' && ready) void refresh()
  })
  const from = useListHref()

  useAdminPageHeader({ title: t('adminEditRequests.title'), subtitle: t('adminEditRequests.subtitle') })

  const statusTabs: TabItem[] = STATUSES.map((key) => ({ key, label: t(EDIT_REQUEST_STATUS_LABEL_KEYS[key] ?? key) }))

  return (
    <div className={shell.page}>
      {/* 与其他后台列表一致：选项卡收在粘性头部里，错误提示放进面板、贴着它所属的列表。 */}
      <div className={shell.stickyHead}>
        <Tabs
          items={statusTabs}
          value={statusFilter}
          onChange={(status) => patch({ status: status === 'pending' ? null : status })}
          ariaLabel={t('adminEditRequests.filterLabel')}
          panelId="edit-request-panel"
        />
      </div>
      <div id="edit-request-panel" role="tabpanel" aria-labelledby={`tab-${statusFilter}`} className={shell.tabpanel}>
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
          <Skeleton rows={6} />
        ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
           不能再把它们摆出来——行还是可点的，点进去会处置一个不属于本视图的条目。 */
        staleResults ? (
          // 已确认不属于当前条件的旧行不再摆出来；重试在途时只给加载提示
          loading ? (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminEditRequests.loading')}
            </div>
          ) : null
        ) : items.length === 0 ? (
          <EmptyState
            title={
              statusFilter === 'pending'
                ? t('adminEditRequests.empty')
                : t('adminEditRequests.emptyWithFilter', {
                    status: t(EDIT_REQUEST_STATUS_LABEL_KEYS[statusFilter] ?? statusFilter),
                  })
            }
          />
        ) : (
          <>
            {loading && (
              <div className={shell.loadingBar} role="status" aria-live="polite">
                {t('adminEditRequests.loading')}
              </div>
            )}
            <ul className={shell.list}>
              {items.map((item, index) => (
                <li key={item.id}>
                  <Link
                    to={`/admin/edit-requests/${encodeURIComponent(item.id)}`}
                    state={{ from, index } satisfies RowLinkState}
                    data-row-id={item.id}
                    className={shell.rowBtn}
                  >
                    <span className={shell.rowMain}>
                      <span className={shell.rowTitle}>
                        {/* 列表接口给的是扁平的 contributionTitle（详情接口才有嵌套的 contribution） */}
                        {item.contribution?.title ??
                          item.contributionTitle ??
                          t('adminEditRequests.contribFallback', {
                            prefix: t('adminEditRequests.contribPrefix'),
                            id: ellipsize(item.contribution?.id ?? item.contributionId ?? '', 20),
                          })}
                      </span>
                      <span className={shell.rowMeta}>{ellipsize(item.reason, 60)}</span>
                      <dl className={shell.metaFields}>
                        <div className={shell.metaField}>
                          <dt>{t('adminEditRequests.requester')}</dt>
                          <dd>{item.requester?.displayName || '—'}</dd>
                        </div>
                        {item.votes && (
                          <div className={shell.metaField}>
                            <dt>{t('adminEditRequests.voteProgress')}</dt>
                            <dd>
                              {t('adminEditRequests.voteTally', {
                                approve: item.votes.approve,
                                reject: item.votes.reject,
                                required: item.votes.required,
                              })}
                            </dd>
                          </div>
                        )}
                        <div className={shell.metaField}>
                          <dt>{t('adminEditRequests.created')}</dt>
                          <dd>
                            <time dateTime={new Date(item.createdAt).toISOString()}>{formatTs(item.createdAt)}</time>
                          </dd>
                        </div>
                      </dl>
                    </span>
                    <span className={shell.rowRight}>
                      <StatusBadge
                        tone={EDIT_REQUEST_STATUS_TONE[item.status] ?? 'neutral'}
                        label={t(EDIT_REQUEST_STATUS_LABEL_KEYS[item.status] ?? item.status)}
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
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          disabled={loading || stale}
          onChange={setPage}
        />
      </div>
    </div>
  )
}
