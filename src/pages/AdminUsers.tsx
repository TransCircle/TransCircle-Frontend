import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList } from '@/hooks/usePagedList'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  ReasonPromptDialog,
  SearchField,
  SectionLabel,
  Skeleton,
  StatusBadge,
  USER_STATUS_TONE,
  USER_STATUS_LABEL_KEYS,
  type DescriptionItem,
} from '@/components/admin'
import { Pagination } from '@/components/ui'
import shell from './Page.module.css'

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

interface RoleEntry {
  id: string
  name: string
  grantedBy: string
  createdAt: number
  expiresAt: number | null
}

interface DetailedUser extends Omit<ManagedUser, 'roles'> {
  avatarUrl: string | null
  oauthAccounts: Array<{ provider: string; providerUsername: string; boundAt: number }>
  security: { hasPassword: boolean; totpEnabled: boolean; passkeyCount: number }
  roles: RoleEntry[]
}

import { useFormatTs } from '@/utils/datetime'
import { useDetailFocus } from '@/hooks/useDetailFocus'

export const AdminUsers = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const formatTs = useFormatTs()

  const [keyword, setKeyword] = useState('')
  /* 已应用的搜索词。输入框的值不能直接进 fetchPage：用户改了关键词但没点搜索
     就翻页时，请求会变成「新 keyword + 旧 cursor」——游标属于上一组筛选条件，
     服务端拿这两者拼不出正确的一页。用 ref 而不是 state，是因为 searchUsers
     写入后要立刻 reload()，state 要等下一次渲染才可见。 */
  const appliedKeywordRef = useRef('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailedUser | null>(null)
  // 行点击→详情拉取中的 pending 反馈（loading-04）
  const [detailLoading, setDetailLoading] = useState(false)

  // 危险操作（封禁/解封）可能返回 STEP_UP_REQUIRED → 弹 step-up（IAM 账号走代理 2FA 跳转）。
  const { runWithStepUp, stepUpElement } = useStepUpAction(accessToken)

  // 封禁原因对话框（替代内联输入行）
  /* 详情侧的错误自成一路，不能和列表的 error 共用一个通道。
     列表那份由 usePagedList 维护，每次加载都会先 setError('')；而详情里的写操作
     在后台会触发一次列表刷新（哪怕用户已经离开那条详情），刷新一开始就把详情
     刚显示出来的失败提示无声清掉了——用户以为操作成功了。 */
  const [detailError, setDetailError] = useState('')

  const [banDialogUserId, setBanDialogUserId] = useState<string | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banError, setBanError] = useState('')

  // 游标分页列表（统一模板）：搜索由 onSearch 显式触发 reload，避免逐键触发请求
  const { items: users, pageIndex, knownPages, hasMore, stale, staleResults, loading, error, setError: setListError, reload, refresh, goToPage } = usePagedList<ManagedUser>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '20' })
      const applied = appliedKeywordRef.current
      if (applied) params.set('keyword', applied)
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<ManagedUser[]>(`/admin/users?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [authLoading, accessToken],
    // 首载由下方 effect 守卫（权限门控 + 只载一次）显式触发，autoLoad 关闭避免重复请求
    autoLoad: false,
  })

  // 首载：auth 就绪且持有 user:read 时加载一次；无权限不发起（页面下方显示拒绝态）
  const loadedRef = useRef(false)
  useEffect(() => {
    if (authLoading || !accessToken) return
    if (!hasPermission(permissions, PERMISSIONS.USER_READ)) return
    if (loadedRef.current) return
    loadedRef.current = true
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken])

  const applyKeyword = (next: string) => {
    appliedKeywordRef.current = next
    void reload()
  }

  const searchUsers = () => applyKeyword(keyword.trim())

  /* 清除按钮必须同步「已应用」的筛选并重载：只清输入框的话，列表仍是旧关键词的
     结果，翻页也继续用旧游标——界面显示「没有筛选」，数据却还在筛选中。 */
  const clearSearch = () => applyKeyword('')

  /* 详情拉取的竞态守卫：快速连点两行时，先发的响应可能后到并覆盖后发的；
     封禁/解封后的重拉同理。只有最新一次请求可以写入详情状态。 */
  const detailSeq = useRef(0)

  /* 封禁/解封的进行中锁。除了避免重复写请求，更关键的是：useStepUpAction 只有
     一个 pendingActionRef，两次并发操作若都返回 STEP_UP_REQUIRED，后一次会覆盖
     前一次，前一次将永远不会被重放。 */
  const [actionSubmitting, setActionSubmitting] = useState(false)

  /* 详情会话守卫。**同步**写入，不用 effect 同步：写操作的响应可能在同一轮
     事件循环的后续 microtask 里就到达，而 effect 要等下一次提交后才跑，
     那时 ref 还是旧 id，守卫会失效。 */
  const selectedIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  /* 详情会话守卫。只比 id 是不够的：返回列表后再打开同一个用户，id 一模一样，
     但已经是另一次会话——旧操作的回调会刷新新会话的详情、或把错误写进去。
     detailSeq 在每次打开详情、返回列表、组件卸载时自增，捕获它即可区分。 */
  /* 详情**会话**序号，与 detailSeq（详情**请求**竞态序号）是两回事，不能复用：
       · detailSeq —— 每次 fetchDetail 都自增，用来丢弃过期的详情响应；
       · sessionSeq —— 只在「打开另一位 / 返回列表 / 卸载」时自增，标识用户
         正在看的是哪一次会话。
     混用会出这样的错：一次重读（旧操作成功后刷新当前这位）也会自增 detailSeq，
     于是当前正在进行的写操作会以为「用户已经离开」，随后的 step-up 和错误提示
     全被静默丢弃。 */
  const sessionSeq = useRef(0)
  /* 列表 ↔ 详情的键盘焦点接力，见 useDetailFocus 的说明。 */
  const { backRef, focusRowOnReturn } = useDetailFocus(!!selectedId && !!detail && !detailLoading, sessionSeq)
  const sameSession = (session: number) => sessionSeq.current === session

  /** 屏幕上打开的是否正是这个用户（不论经历过几次会话）。 */
  const viewingSame = (id: string) => selectedIdRef.current === id

  /**
   * 拉取用户详情。
   *
   * 拉取失败一律收起详情：初次打开另一位时不收起会把上一位的资料渲染在新 id 下；
   * 写成功后读不回新状态时不收起，则等于把未知的旧状态和一排可用的按钮交给用户。
   */
  const fetchDetail = async (userId: string, opts: { refresh?: boolean } = {}) => {
    // refresh 即「重读当前这一位」；只有打开另一位才算新会话
    if (!opts.refresh) sessionSeq.current++
    const seq = ++detailSeq.current
    selectedIdRef.current = userId
    /* 只有「打开另一条」才清详情错误。重读**当前这一条**时不能清：那次重读常常
       是上一次操作的收尾（跨会话刷新），而屏幕上正显示着新会话里刚失败的提示，
       清掉等于把用户刚看到的失败悄悄抹了。各个写操作入口自己会先清一次。 */
    if (!opts.refresh) setDetailError('')
    setSelectedId(userId)
    setDetailLoading(true)
    try {
      const result = await get<DetailedUser>(`/admin/users/${userId}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (seq !== detailSeq.current) return // 过期响应，丢弃
      if (result.ok) setDetail(result.data)
      else {
        // 自动收起也要还焦点：行按钮在加载骨架屏时已被卸载，不还的话焦点停在 body
        focusRowOnReturn(userId)
        /* 自动收起同样是「这次会话结束了」：不推进 sessionSeq 的话，另一个在途
           写操作捕获的会话仍会被判为有效，它的错误和 step-up 会弹到列表上，
           成功分支甚至会把刚收起的详情重新打开。 */
        sessionSeq.current++
        // 理由弹窗随详情一起收掉，理由见 leaveDetail
        setBanDialogUserId(null)
        setBanReason('')
        setBanError('')
        setDetail(null)
        setSelectedId(null)
        selectedIdRef.current = null
        /* 详情已经收起，detailError 不会再被渲染——这条必须走列表通道，
           否则「打不开这位用户」的原因就此丢失，界面上只是默默回到了列表。 */
        setListError(result.error.message)
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }

  /* 提交锁的归属序号。锁是页面级的单个布尔值，而操作是详情级的：用户可以在
     请求在途时返回列表、打开另一个用户并发起新的操作。不记归属的话，旧操作
     结束时会把新操作的锁一起放掉，而返回列表又会让新详情继承一把解不开的锁。 */
  const actionSeqRef = useRef(0)

  /** 返回列表：作废在途详情请求与在途操作对锁的归属。 */
  const leaveDetail = () => {
    // 回到列表：把焦点还给当初点开的那一行
    focusRowOnReturn(selectedIdRef.current)
    /* 封禁理由弹窗属于刚才那位用户，必须一起收掉。留着的话它会跟着用户去到
       下一位的详情：弹窗一打开就在那儿，而 submitBan 提交时读的仍是旧的
       banDialogUserId——理由是给 A 写的，请求也发往 A，屏幕上却是 B。 */
    setBanDialogUserId(null)
    setBanReason('')
    setBanError('')

    /* 详情侧的提示随详情一起收掉——它属于刚才那条记录，而详情分支马上就不渲染了。 */
    setDetailError('')
    detailSeq.current++ // 使在途详情请求失效
    sessionSeq.current++ // 会话结束：在途操作的回调不再写这一页
    actionSeqRef.current++
    selectedIdRef.current = null
    setSelectedId(null)
    setDetail(null)
    setActionSubmitting(false)
  }

  const openBan = (userId: string) => {
    setBanReason('')
    setBanError('')
    setDetailError('')
    setBanDialogUserId(userId)
  }

  const submitBan = async () => {
    if (!banDialogUserId) return
    const reason = banReason.trim()
    // 封禁理由 1-500 字符（api.md §7.5 / 后端 admin.ts 校验一致）
    if (!reason || reason.length > 500) {
      setBanError(t('adminUsers.banReasonRequired'))
      return
    }
    if (actionSubmitting) return
    const userId = banDialogUserId
    setBanDialogUserId(null)
    setBanError('')
    const session = sessionSeq.current
    const mySeq = ++actionSeqRef.current
    setActionSubmitting(true)
    setDetailError('')
    let handedOff = false
    const doBan = async () => {
      const result = await post(
        `/admin/users/${userId}/ban`,
        { reason },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (result.ok) {
        /* 会话虽然换了，但屏幕上打开的正是同一个用户（返回列表后又点开了）：
           它显示的还是操作前的旧状态，必须刷新。刷新是对「当前显示的这条」做的，
           与哪一次会话发起的操作无关，所以这里只比 id。 */
        /* 写操作已经成功，这次是去读回新状态。默认 keepOnError=false：
           万一读不回来，屏幕上那份的状态就是未知的，留着它等于把过期状态
           和一排可用的按钮交给用户，他会基于旧状态再点一次。收起回列表，
           紧随其后的 reload() 会把真实结果摆出来。 */
        if (sameSession(session) || viewingSame(userId)) await fetchDetail(userId, { refresh: true })
        if (mountedRef.current) void refresh()
      } else if (result.error.code === 'STEP_UP_REQUIRED') {
        /* 用户已经离开这位的详情：403 时后端什么都没做，这次操作没有生效。
           此时再弹二次验证会覆盖掉新详情正在等的那一轮，而旧回调的 onSettled
           又释放不了新操作的锁，按钮会永久锁死。直接放弃本次操作。 */
        if (!sameSession(session)) return
        handedOff = true
        runWithStepUp(doBan, () => {
          if (actionSeqRef.current === mySeq) setActionSubmitting(false)
        })
      } else if (sameSession(session)) {
        setDetailError(result.error.message)
      } else {
        // 已经离开这次详情会话：页面级错误会落到列表上、指向一个看不见的对象，
        // 改为刷新列表让真实状态自己说话（同 Admin.tsx 的处理）
        if (mountedRef.current) void refresh()
      }
    }
    try {
      await doBan()
    } finally {
      if (!handedOff && actionSeqRef.current === mySeq) setActionSubmitting(false)
    }
  }

  const handleUnban = async (userId: string) => {
    if (actionSubmitting) return
    const session = sessionSeq.current
    const mySeq = ++actionSeqRef.current
    setActionSubmitting(true)
    setDetailError('')
    let handedOff = false
    const doUnban = async () => {
      const result = await post(
        `/admin/users/${userId}/unban`,
        { reason: t('adminUsers.adminUnban') },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (result.ok) {
        /* 会话虽然换了，但屏幕上打开的正是同一个用户（返回列表后又点开了）：
           它显示的还是操作前的旧状态，必须刷新。刷新是对「当前显示的这条」做的，
           与哪一次会话发起的操作无关，所以这里只比 id。 */
        /* 写操作已经成功，这次是去读回新状态。默认 keepOnError=false：
           万一读不回来，屏幕上那份的状态就是未知的，留着它等于把过期状态
           和一排可用的按钮交给用户，他会基于旧状态再点一次。收起回列表，
           紧随其后的 reload() 会把真实结果摆出来。 */
        if (sameSession(session) || viewingSame(userId)) await fetchDetail(userId, { refresh: true })
        if (mountedRef.current) void refresh()
      } else if (result.error.code === 'STEP_UP_REQUIRED') {
        /* 用户已经离开这位的详情：403 时后端什么都没做，这次操作没有生效。
           此时再弹二次验证会覆盖掉新详情正在等的那一轮，而旧回调的 onSettled
           又释放不了新操作的锁，按钮会永久锁死。直接放弃本次操作。 */
        if (!sameSession(session)) return
        handedOff = true
        runWithStepUp(doUnban, () => {
          if (actionSeqRef.current === mySeq) setActionSubmitting(false)
        })
      } else if (sameSession(session)) {
        setDetailError(result.error.message)
      } else {
        // 已经离开这次详情会话：页面级错误会落到列表上、指向一个看不见的对象，
        // 改为刷新列表让真实状态自己说话（同 Admin.tsx 的处理）
        if (mountedRef.current) void refresh()
      }
    }
    try {
      await doUnban()
    } finally {
      if (!handedOff && actionSeqRef.current === mySeq) setActionSubmitting(false)
    }
  }

  // 行点击后的详情拉取中：显示详情骨架，避免慢网下「点击像无效」或无占位跳变（loading-04）
  /* 组件卸载（从顶部导航离开，而不是点页内的返回按钮）：作废在途会话与写操作，
     否则旧回调仍会写状态、甚至在卸载后再发一次列表请求。 */
  useEffect(() => {
      // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，ref 不会重建
    mountedRef.current = true
    const detail = detailSeq
    const session = sessionSeq
    const action = actionSeqRef
    const mounted = mountedRef
    const selectedId = selectedIdRef
    return () => {
      detail.current++
      session.current++
      action.current++
      mounted.current = false
      /* 也要清掉当前详情 id：viewingSame() 只比 id，不清的话组件已经卸载了，
         旧回调仍会认为「这条还开着」，继续写状态、甚至再发一次详情请求。 */
      selectedId.current = null
    }
  }, [])

  if (selectedId && detailLoading) {
    return (
      <div className={shell.page}>
        <Skeleton variant="card" />
      </div>
    )
  }

  if (selectedId && detail) {
    const metaItems: DescriptionItem[] = [
      {
        term: t('adminUsers.email'),
        value: (
          <span className={shell.inlineMeta}>
            {detail.email ?? '—'}
            <StatusBadge
              tone={detail.emailVerified ? 'green' : 'red'}
              label={t(detail.emailVerified ? 'adminUsers.emailVerified' : 'adminUsers.emailUnverified')}
              size="sm"
            />
          </span>
        ),
      },
      {
        term: t('adminUsers.status'),
        value: (
          <StatusBadge
            tone={USER_STATUS_TONE[detail.status] ?? 'neutral'}
            label={t(USER_STATUS_LABEL_KEYS[detail.status] ?? detail.status)}
            size="sm"
          />
        ),
      },
      { term: t('adminUsers.createdAt'), value: formatTs(detail.createdAt) || '—' },
      { term: t('adminUsers.lastLogin'), value: formatTs(detail.lastLoginAt) || '—' },
      {
        term: t('adminUsers.passwordLabel'),
        value: detail.security.hasPassword ? t('adminUsers.hasPassword') : t('adminUsers.noPassword'),
      },
      { term: t('adminUsers.totpLabel'), value: detail.security.totpEnabled ? t('adminUsers.totpEnabled') : t('adminUsers.totpDisabled') },
      { term: t('adminUsers.passkeyLabel'), value: `${detail.security.passkeyCount}${t('adminUsers.passkeyUnit')}` },
    ]

    return (
      <div className={shell.page}>
        <div>
          <AdminButton
            ref={backRef}
            variant="ghost"
            size="sm"
            onClick={leaveDetail}
          >
            {t('adminUsers.backToList')}
          </AdminButton>
        </div>

        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>
              {detail.displayName} <span className={shell.detailTitleSub}>@{detail.username}</span>
            </h2>

            <DescriptionList items={metaItems} columns={2} />

            {detail.oauthAccounts.length > 0 && (
              <div>
                <SectionLabel>{t('adminUsers.oauthLabel')}</SectionLabel>
                <ul className={shell.history}>
                  {detail.oauthAccounts.map((oa) => (
                    <li key={oa.provider} className={shell.historyItem}>
                      {t('adminUsers.oauthAccount', { provider: oa.provider, username: oa.providerUsername })}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <SectionLabel>{t('adminUsers.roles')}</SectionLabel>
              {detail.roles.length === 0 ? (
                <p className={shell.subtleNote}>{t('adminUsers.noRoles')}</p>
              ) : (
                <ul className={shell.history}>
                  {detail.roles.map((r) => (
                    <li key={r.id} className={shell.historyItem}>
                      {r.name}（
                      {r.expiresAt
                        ? t('adminUsers.expiresAt', { time: formatTs(r.expiresAt) })
                        : t('adminUsers.permanent')}
                      ）
                    </li>
                  ))}
                </ul>
              )}
              {/* 授权统一迁移到 IAM：本平台不再人工授予/撤销角色（iam-admin-api.md §4.4） */}
              <p className={shell.subtleNoteSpaced}>{t('adminUsers.rolesManagedInIam')}</p>
            </div>

            {detailError && <Alert tone="error">{detailError}</Alert>}

            {/* 封禁/解封需 user:ban（仅 admin）；editor 仅有 user:read 时只读不可操作 */}
            {hasPermission(permissions, PERMISSIONS.USER_BAN) && (
              <div className={shell.actions}>
                {detail.status === 'banned' ? (
                  <AdminButton variant="primary" loading={actionSubmitting} onClick={() => handleUnban(detail.id)}>
                    {t('adminUsers.unban')}
                  </AdminButton>
                ) : (
                  <AdminButton variant="danger" disabled={actionSubmitting} onClick={() => openBan(detail.id)}>
                    {t('adminUsers.ban')}
                  </AdminButton>
                )}
              </div>
            )}
          </div>
        </Card>

        <ReasonPromptDialog
          open={banDialogUserId !== null}
          title={t('adminUsers.banTitle')}
          prompt={t('adminUsers.banReasonPrompt')}
          placeholder={t('adminUsers.banReasonPlaceholder')}
          value={banReason}
          onChange={setBanReason}
          onSubmit={submitBan}
          onCancel={() => {
            setBanDialogUserId(null)
            setBanError('')
          }}
          submitText={t('adminUsers.ban')}
          cancelText={t('admin.cancelReason')}
          maxLength={500}
          counterText={t('admin.ui.charCount', { n: banReason.length, max: 500 })}
          error={banError || undefined}
          variant="danger"
        />

        {stepUpElement}
      </div>
    )
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

      {error && <Alert tone="error">{error}</Alert>}

      {loading && users.length === 0 ? (
        <Skeleton rows={7} />
      ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
         不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
         对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
      staleResults ? null : users.length === 0 ? (
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
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                data-row-id={u.id}
                className={shell.rowBtn}
                onClick={() => fetchDetail(u.id)}
              >
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>{u.displayName}</span>
                  <span className={shell.rowMeta}>
                    @{u.username}
                    <span className={shell.rowMetaSep}>·</span>
                    {u.email ?? '—'}
                  </span>
                </span>
                <span className={shell.rowRight}>
                  <StatusBadge
                    tone={USER_STATUS_TONE[u.status] ?? 'neutral'}
                    label={t(USER_STATUS_LABEL_KEYS[u.status] ?? u.status)}
                    size="sm"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
        </>
      )}

      <Pagination
        pageIndex={pageIndex}
        knownPages={knownPages}
        hasMore={hasMore}
        disabled={loading || stale}
        onChange={goToPage}
      />

      {/* step-up 宿主必须在列表分支也渲染：封禁/解封进行中返回列表会卸载详情分支，
          届时待重放的操作和验证框会一起消失，操作既无法完成、锁也无从释放。 */}
      {stepUpElement}
    </div>
  )
}
