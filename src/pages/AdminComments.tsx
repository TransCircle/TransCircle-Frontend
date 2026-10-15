import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { ellipsize } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  EmptyState,
  Pagination,
  Pill,
  Select,
  Skeleton,
  StatusBadge,
  type BadgeTone,
} from '@/components/ui'
import { ChevronRightIcon } from '@/components/ui'
import shell from './Page.module.css'
import { useAdminPageHeader } from './admin/header'
import { useAdminChange } from './admin/changes'
import { useListHref, useListParams, useReturnFocus, type RowLinkState } from './admin/listParams'

const PAGE_SIZE = 50

interface AdminComment {
  id: string
  contributionId: string
  contributionTitle: string | null
  /** 所属投稿已删除（后台详情打不开） */
  contributionDeleted?: boolean
  author: { displayName: string; avatarUrl: string | null }
  content: string | null
  parentId: string | null
  status: 'visible' | 'hidden' | 'deleted'
  deletedAt: number | null
  reportCount: number
  createdAt: number
  updatedAt: number
}

type StatusFilter = 'all' | 'visible' | 'hidden' | 'deleted'
const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'visible', 'hidden', 'deleted']

/* 排序（后端 GET /admin/comments 的 sort）：默认最新发表在前；「举报最多」把被举报的评论排到前面优先处理，
   同数按发表时间倒序。默认值不写进 URL。 */
type CommentSort = 'createdAt_desc' | 'reportCount_desc'
const DEFAULT_SORT: CommentSort = 'createdAt_desc'
const SORTS: readonly CommentSort[] = ['createdAt_desc', 'reportCount_desc']

const STATUS_TONE: Record<AdminComment['status'], BadgeTone> = {
  visible: 'green',
  hidden: 'amber',
  deleted: 'muted',
}

/**
 * 评论管理列表（/admin/comments）。
 *
 * 每行是一条评论的入口：两行摘要、作者、所属投稿、发表时间，右侧是状态与举报数。
 * 隐藏 / 恢复在详情页（/admin/comments/:id）做——那里有全文、举报理由、回复关系与处理记录。
 */
export const AdminComments = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading, permissions } = useAuth()

  // 状态筛选、排序与页码在 URL 里（?status=&sort=&page=）：刷新、分享、从详情返回都回到同一个视图
  const { searchParams, patch, page: urlPage, setPage } = useListParams()
  const rawStatus = searchParams.get('status')
  const statusFilter: StatusFilter = STATUS_FILTERS.includes(rawStatus as StatusFilter)
    ? (rawStatus as StatusFilter)
    : 'all'
  const setStatusFilter = (next: StatusFilter) => patch({ status: next === 'all' ? null : next })
  const rawSort = searchParams.get('sort')
  const sort: CommentSort = SORTS.includes(rawSort as CommentSort) ? (rawSort as CommentSort) : DEFAULT_SORT
  const setSort = (next: CommentSort) => patch({ sort: next === DEFAULT_SORT ? null : next })
  const ready = !authLoading && !!accessToken && hasPermission(permissions, PERMISSIONS.COMMENT_MODERATE)

  const { items, page, total, totalPages, stale, staleResults, loading, error, refresh } = usePagedList<AdminComment>({
    fetchPage: async (targetPage) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (sort !== DEFAULT_SORT) params.set('sort', sort)
      const result = await get<AdminComment[]>(`/admin/comments?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return toPagedResult(result.data, result.pagination)
    },
    deps: [ready, statusFilter, sort],
    autoLoad: ready,
    page: urlPage,
    // 越界页被服务端回落时，把实际页码写回 URL
    onPageMismatch: setPage,
  })
  useReturnFocus(!loading && items.length > 0)
  // 详情页隐藏 / 恢复成功：就地重取当前页（处理过的那条可能移出当前筛选，或连带了它的回复）
  useAdminChange((change) => {
    if (change.kind === 'comment' && ready) void refresh()
  })
  const from = useListHref()
  useAdminPageHeader({ title: t('adminComments.title'), subtitle: t('adminComments.subtitle') })

  const statusLabel = (status: AdminComment['status']) => {
    if (status === 'visible') return t('adminComments.statusVisible')
    if (status === 'hidden') return t('adminComments.statusHidden')
    return t('adminComments.statusDeleted')
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.headRow}>
          <p className={shell.headNote}>{t('adminComments.listNote')}</p>
          <div className={shell.headFilters}>
            <Select<StatusFilter>
              value={statusFilter}
              onChange={setStatusFilter}
              ariaLabel={t('adminComments.status')}
              fieldClassName={shell.headFilter}
              options={[
                { value: 'all', label: t('adminComments.statusAll') },
                { value: 'visible', label: t('adminComments.statusVisible') },
                { value: 'hidden', label: t('adminComments.statusHidden') },
                { value: 'deleted', label: t('adminComments.statusDeleted') },
              ]}
            />
            <Select<CommentSort>
              value={sort}
              onChange={setSort}
              ariaLabel={t('adminComments.sortLabel')}
              fieldClassName={shell.headFilter}
              options={[
                { value: 'createdAt_desc', label: t('adminComments.sortNewest') },
                { value: 'reportCount_desc', label: t('adminComments.sortMostReported') },
              ]}
            />
          </div>
        </div>
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
        <Skeleton rows={8} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——行还是可点的，点进去会处置一个不属于本视图的条目。 */
      staleResults ? (
        // 已确认不属于当前条件的旧行不再摆出来；重试在途时只给加载提示
        loading ? (
          <div className={shell.loadingBar} role="status" aria-live="polite">
            {t('adminComments.loading')}
          </div>
        ) : null
      ) : items.length === 0 ? (
        <EmptyState title={t('adminComments.empty')} />
      ) : (
        <>
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminComments.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {items.map((comment, index) => (
              <li key={comment.id}>
                <Link
                  to={`/admin/comments/${encodeURIComponent(comment.id)}`}
                  state={{ from, index } satisfies RowLinkState}
                  data-row-id={comment.id}
                  className={shell.rowBtn}
                >
                  <span className={shell.rowMain}>
                    {/* 行标题就是评论本身：两行摘要，全文在详情里 */}
                    {comment.content ? (
                      <span className={shell.rowExcerpt}>{comment.content}</span>
                    ) : (
                      <span className={shell.rowExcerptMuted}>{t('comment.deletedPlaceholder')}</span>
                    )}
                    {/* 带标签的字段，不用圆点串成一行（同审计日志）。整行是链接，所属投稿只给名称，链接在详情里 */}
                    <dl className={shell.metaFields}>
                      <div className={shell.metaField}>
                        <dt>{t('adminComments.author')}</dt>
                        <dd>{comment.author.displayName}</dd>
                      </div>
                      <div className={shell.metaField}>
                        <dt>{t('adminComments.contribution')}</dt>
                        <dd>
                          {/* 标题为空只会是投稿行已不存在：说明情况，不拿 ID 充当名字 */}
                          {comment.contributionTitle === null ? (
                            <span className={shell.auditMuted}>{t('adminComments.contributionMissing')}</span>
                          ) : (
                            ellipsize(comment.contributionTitle, 28)
                          )}
                          {comment.contributionDeleted && (
                            <span className={shell.auditMuted}>{t('adminAuditLogs.deleted')}</span>
                          )}
                        </dd>
                      </div>
                      <div className={shell.metaField}>
                        <dt>{t('adminComments.postedAt')}</dt>
                        <dd>
                          <time dateTime={new Date(comment.createdAt).toISOString()}>
                            {formatTs(comment.createdAt)}
                          </time>
                        </dd>
                      </div>
                    </dl>
                  </span>
                  <span className={shell.rowRight}>
                    {/* 举报数是分诊信号：有举报才标出来，按「举报最多」排序时一眼对上 */}
                    {comment.reportCount > 0 && (
                      <Pill>{t('adminComments.reportPill', { count: comment.reportCount })}</Pill>
                    )}
                    <StatusBadge tone={STATUS_TONE[comment.status]} label={statusLabel(comment.status)} size="sm" />
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

      {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
          （并发删除、状态变更），读者仍需要能退回上一页。
          控件本身在只有一页时会自行隐藏。 */}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        disabled={loading || stale}
        onChange={setPage}
      />
    </div>
  )
}
