import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import {
  AdminButton,
  Alert,
  EmptyState,
  SearchField,
  Skeleton,
  StatusBadge,
  USER_STATUS_TONE,
  USER_STATUS_LABEL_KEYS,
} from '@/components/admin'
import { ChevronRightIcon, Pagination } from '@/components/ui'
import shell from './Page.module.css'
import { useAdminPageHeader } from './admin/header'
import { useAdminChange } from './admin/changes'
import { useListHref, useListParams, useReturnFocus, type RowLinkState } from './admin/listParams'

const PAGE_SIZE = 20

interface ManagedUser {
  id: string
  username: string
  displayName: string
  email: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  createdAt: number
  lastLoginAt: number | null
}

/**
 * 用户列表（/admin/users?q=）。点一行进入 /admin/users/:id。
 * 关键词在回车 / 点「搜索」时才生效并写进 URL：用户表可能很大，不逐键查询。
 */
export const AdminUsers = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const { searchParams, patch, page: urlPage, setPage } = useListParams()
  const appliedKeyword = (searchParams.get('q') ?? '').trim()
  const [keyword, setKeyword] = useState(appliedKeyword)
  const ready = !authLoading && !!accessToken && hasPermission(permissions, PERMISSIONS.USER_READ)

  /* 已应用的关键词变了（后退、外链带 ?q=）而不是本页刚写进去的：回填输入框。 */
  const lastAppliedRef = useRef(appliedKeyword)
  useEffect(() => {
    if (appliedKeyword === lastAppliedRef.current) return
    lastAppliedRef.current = appliedKeyword
    setKeyword(appliedKeyword)
  }, [appliedKeyword])

  // 页码分页列表（统一模板）：关键词来自 URL，只有「已应用」的那个会进请求
  const {
    items: users,
    page,
    total,
    totalPages,
    stale,
    staleResults,
    loading,
    error,
    refresh,
  } = usePagedList<ManagedUser>({
    fetchPage: async (targetPage) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
      if (appliedKeyword) params.set('keyword', appliedKeyword)
      // apiRequest 自动注入 Authorization 并处理 401 刷新
      const result = await get<ManagedUser[]>(`/admin/users?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return toPagedResult(result.data, result.pagination)
    },
    deps: [ready, appliedKeyword],
    autoLoad: ready,
    page: urlPage,
    // 越界页被服务端回落时，把实际页码写回 URL
    onPageMismatch: setPage,
  })
  useReturnFocus(!loading && users.length > 0)
  // 别处（详情页）封禁 / 解封成功：就地重取当前页
  useAdminChange((change) => {
    if (change.kind === 'user' && ready) void refresh()
  })
  const from = useListHref()

  useAdminPageHeader({ title: t('adminUsers.title'), subtitle: t('adminUsers.subtitle') })

  const applyKeyword = (next: string) => {
    // 条件没变（如加载失败后再点一次搜索）：URL 不会变，直接重取
    if (next === appliedKeyword) {
      void refresh()
      return
    }
    lastAppliedRef.current = next
    patch({ q: next || null })
  }

  const searchUsers = () => applyKeyword(keyword.trim())

  /* 清除按钮必须同步「已应用」的筛选：只清输入框的话，列表仍是旧关键词的结果——
     界面显示「没有筛选」，数据却还在筛选中。 */
  const clearSearch = () => {
    setKeyword('')
    applyKeyword('')
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <SearchField
            value={keyword}
            onValueChange={setKeyword}
            onSearch={searchUsers}
            onClear={clearSearch}
            placeholder={t('adminUsers.searchPlaceholder')}
            searchAriaLabel={t('adminUsers.searchPlaceholder')}
            clearAriaLabel={t('admin.ui.clear')}
            fieldClassName={shell.grow}
          />
          <AdminButton variant="secondary" onClick={searchUsers}>
            {t('adminUsers.search')}
          </AdminButton>
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

      {loading && users.length === 0 ? (
        <Skeleton rows={7} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——行还是可点的，点进去会处置一个不属于本视图的条目。 */
      staleResults ? (
        // 已确认不属于当前条件的旧行不再摆出来；重试在途时只给加载提示
        loading ? (
          <div className={shell.loadingBar} role="status" aria-live="polite">
            {t('adminUsers.loading')}
          </div>
        ) : null
      ) : users.length === 0 ? (
        <EmptyState title={t('adminUsers.empty')} />
      ) : (
        <>
          {/* 搜索/刷新时保留旧列表，顶部显示轻量加载条 */}
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminUsers.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {users.map((u, index) => (
              <li key={u.id}>
                <Link
                  to={`/admin/users/${encodeURIComponent(u.id)}`}
                  state={{ from, index } satisfies RowLinkState}
                  data-row-id={u.id}
                  className={shell.rowBtn}
                >
                  <span className={shell.rowMain}>
                    <span className={shell.rowTitle}>{u.displayName}</span>
                    <span className={shell.rowMeta}>
                      {t('common.handle', { username: u.username })}
                      {u.email && (
                        <>
                          <span className={shell.rowMetaSep} aria-hidden="true">
                            ·
                          </span>
                          {u.email}
                        </>
                      )}
                    </span>
                  </span>
                  <span className={shell.rowRight}>
                    <StatusBadge
                      tone={USER_STATUS_TONE[u.status] ?? 'neutral'}
                      label={t(USER_STATUS_LABEL_KEYS[u.status] ?? u.status)}
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
  )
}
