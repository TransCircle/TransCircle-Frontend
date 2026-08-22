import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { ERRORS } from '@/api/errors'
import { usePagedList } from '@/hooks/usePagedList'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { limitByUnicode } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  ConfirmDialog,
  EmptyState,
  Pagination,
  ReasonPromptDialog,
  Select,
  Skeleton,
  StatusBadge,
  type BadgeTone,
} from '@/components/ui'
import shell from './Page.module.css'

interface AdminComment {
  id: string
  contributionId: string
  contributionTitle: string | null
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

const STATUS_TONE: Record<AdminComment['status'], BadgeTone> = {
  visible: 'green',
  hidden: 'amber',
  deleted: 'muted',
}

export const AdminComments = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const { stepUpElement, runWithStepUp } = useStepUpAction(accessToken)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [hideTarget, setHideTarget] = useState<AdminComment | null>(null)
  const [hideReason, setHideReason] = useState('')
  const [hideSubmitting, setHideSubmitting] = useState(false)
  const [hideError, setHideError] = useState('')
  const [restoreTarget, setRestoreTarget] = useState<AdminComment | null>(null)
  const [restoreSubmitting, setRestoreSubmitting] = useState(false)
  const [restoreError, setRestoreError] = useState('')

  const { items, pageIndex, knownPages, hasMore, stale, staleResults, loadFailed, loading, error, setError: setListError, reload, refresh, goToPage } = usePagedList<AdminComment>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '50' })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<AdminComment[]>(`/admin/comments?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [statusFilter],
    autoLoad: false,
  })

  useEffect(() => {
    if (authLoading || !accessToken) return
    if (!hasPermission(permissions, PERMISSIONS.COMMENT_MODERATE)) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken, statusFilter, permissions])

  /* 组件卸载后旧回调仍会跑完：弹窗虽在提交期间禁止关闭（Modal 的 busy），
     但用户可以直接从顶部导航离开。此时不该再发一次列表请求。 */
  const mountedRef = useRef(true)

  /* 行操作在「写成功 → 新状态读回来」这段时间里必须锁住。
     锁在请求返回时就放掉、而列表刷新还在路上，屏幕上那条评论仍显示旧状态、
     按钮也还可点——再点一次会带着原来的 updatedAt 重发，稳定撞版本冲突。
     loadFailed 覆盖的是另一半：刷新**失败**后 loading 落回 false，屏幕上留着的
     同样是过时状态，此时更不能让人基于它再写一次。任何一次成功加载都会解锁。 */
  const rowActionsLocked = loading || hideSubmitting || restoreSubmitting || loadFailed
  /* 当前生效的状态筛选。写回冲突提示前要比对它：`await reload()` 期间用户可能
     已经切了筛选，此时那条提示描述的是另一批数据里的某条评论，落在新列表上
     只会让人莫名其妙。用 ref 而不是闭包里的 state，才能读到「现在」的值。 */
  const statusFilterRef = useRef(statusFilter)
  useEffect(() => {
    statusFilterRef.current = statusFilter
  }, [statusFilter])

  const performHide = async () => {
    // 重入保护：Enter 连按、以及 step-up 重放都会再次进入这里
    if (!hideTarget || hideSubmitting) return
    if (!hideReason.trim()) {
      setHideError(t('adminComments.reasonRequired'))
      return
    }
    if (hideReason.length > 200) {
      setHideError(t('adminComments.reasonTooLong'))
      return
    }
    setHideSubmitting(true)
    setHideError('')
    const result = await post<{ id: string; status: string; updatedAt: number }>(`/admin/comments/${hideTarget.id}/hide`, {
      reason: hideReason,
      expectedVersion: hideTarget.updatedAt,
    })
    setHideSubmitting(false)
    if (!result.ok) {
      if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
        /* onSettled 必须传：用户在 step-up 里点取消时，useStepUpAction 只会调用它来
           还锁。漏传的话 hideSubmitting 永远为 true，理由弹窗的取消按钮/Esc/遮罩
           全被 busy 锁死，只能整页离开（同 Admin.tsx / AdminUsers.tsx 的处理）。 */
        runWithStepUp(performHide, () => setHideSubmitting(false))
        return
      }
      if (result.error.code === ERRORS.VERSION_CONFLICT) {
      /* 版本冲突：弹窗里握着的 updatedAt 已经过期，原样再点一次必然又是同一个
         冲突。关掉弹窗并刷新列表，让管理员看到别人改成什么样了再决定。 */
        setHideTarget(null)
        setHideReason('')
        if (mountedRef.current) {
          const filterAtStart = statusFilterRef.current
          await refresh()
          // reload 自身失败时保留它的错误——那个更要紧；筛选换了就别写了
          if (mountedRef.current && statusFilterRef.current === filterAtStart) {
            setListError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        }
        return
      }
      setHideError(result.error?.message || t('adminComments.hideError'))
      return
    }
    setHideTarget(null)
    setHideReason('')
    if (mountedRef.current) await refresh()
  }

  const performRestore = async () => {
    if (!restoreTarget) return
    setRestoreSubmitting(true)
    setRestoreError('')
    const result = await post<{ id: string; status: string; updatedAt: number }>(`/admin/comments/${restoreTarget.id}/restore`, {
      expectedVersion: restoreTarget.updatedAt,
    })
    setRestoreSubmitting(false)
    if (!result.ok) {
      if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
        /* api.md §5A.4：hide 与 restore 同属 requireStepUp 的敏感处置组。
           onSettled 传参理由同 performHide——取消 step-up 时必须把锁还回去。 */
        runWithStepUp(performRestore, () => setRestoreSubmitting(false))
        return
      }
      if (result.error.code === ERRORS.VERSION_CONFLICT) {
      /* 版本冲突：弹窗里握着的 updatedAt 已经过期，原样再点一次必然又是同一个
         冲突。关掉弹窗并刷新列表，让管理员看到别人改成什么样了再决定。 */
        setRestoreTarget(null)
        if (mountedRef.current) {
          const filterAtStart = statusFilterRef.current
          await refresh()
          // reload 自身失败时保留它的错误——那个更要紧；筛选换了就别写了
          if (mountedRef.current && statusFilterRef.current === filterAtStart) {
            setListError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        }
        return
      }
      setRestoreError(result.error?.message || t('adminComments.restoreError'))
      return
    }
    setRestoreTarget(null)
    if (mountedRef.current) await refresh()
  }

  useEffect(() => {
      // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，ref 不会重建
    mountedRef.current = true
    const mounted = mountedRef
    return () => {
      mounted.current = false
    }
  }, [])

  const statusLabel = (status: AdminComment['status']) => {
    if (status === 'visible') return t('adminComments.statusVisible')
    if (status === 'hidden') return t('adminComments.statusHidden')
    return t('adminComments.statusDeleted')
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <Select<StatusFilter>
            value={statusFilter}
            onChange={setStatusFilter}
            ariaLabel={t('adminComments.status')}
            fieldClassName={shell.grow}
            options={[
              { value: 'all', label: t('adminComments.statusAll') },
              { value: 'visible', label: t('adminComments.statusVisible') },
              { value: 'hidden', label: t('adminComments.statusHidden') },
              { value: 'deleted', label: t('adminComments.statusDeleted') },
            ]}
          />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && items.length === 0 ? (
        <Skeleton rows={8} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
         对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
      staleResults ? null : items.length === 0 ? (
        <EmptyState title={t('adminComments.empty')} />
      ) : (
        <>
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminComments.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {items.map((comment) => (
              <li key={comment.id} className={shell.rowStatic}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>
                    {comment.content ? limitByUnicode(comment.content, 120) : t('comment.deletedPlaceholder')}
                  </span>
                  <span className={shell.rowMeta}>
                    <span>{t('adminComments.author')}: {comment.author.displayName}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{t('adminComments.contribution')}: {limitByUnicode(comment.contributionTitle ?? comment.contributionId, 28)}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{t('adminComments.reportCount')}: {comment.reportCount}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{formatTs(comment.createdAt)}</span>
                  </span>
                </span>
                <span className={shell.rowRight}>
                  <StatusBadge tone={STATUS_TONE[comment.status]} label={statusLabel(comment.status)} />
                  {comment.status === 'visible' && (
                    <AdminButton
                      variant="ghost"
                      size="sm"
                      disabled={rowActionsLocked}
                      onClick={() => { setHideTarget(comment); setHideReason(''); setHideError('') }}
                    >
                      {t('adminComments.hide')}
                    </AdminButton>
                  )}
                  {comment.status === 'hidden' && (
                    <AdminButton
                      variant="secondary"
                      size="sm"
                      disabled={rowActionsLocked}
                      onClick={() => { setRestoreTarget(comment); setRestoreError('') }}
                    >
                      {t('adminComments.restore')}
                    </AdminButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
          （并发删除、状态变更、游标过期），读者仍需要能退回上一页。
          控件本身在只有一页时会自行隐藏。 */}
      <Pagination
        pageIndex={pageIndex}
        knownPages={knownPages}
        hasMore={hasMore}
        disabled={loading || stale}
        onChange={goToPage}
      />

      <ReasonPromptDialog
        open={hideTarget !== null}
        title={t('adminComments.hideTitle')}
        prompt={t('adminComments.hidePrompt')}
        placeholder={t('adminComments.hidePlaceholder')}
        value={hideReason}
        onChange={setHideReason}
        onSubmit={() => void performHide()}
        onCancel={() => { setHideTarget(null); setHideReason(''); setHideError('') }}
        submitText={t('adminComments.hide')}
        cancelText={t('common.cancel')}
        maxLength={200}
        error={hideError}
        variant="danger"
        submitting={hideSubmitting}
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        title={t('adminComments.restoreTitle')}
        message={t('adminComments.restoreConfirm')}
        confirmText={t('adminComments.restore')}
        cancelText={t('common.cancel')}
        confirmLoading={restoreSubmitting}
        error={restoreError}
        onConfirm={() => void performRestore()}
        onCancel={() => { setRestoreTarget(null); setRestoreError('') }}
      />
      {stepUpElement}
    </div>
  )
}
