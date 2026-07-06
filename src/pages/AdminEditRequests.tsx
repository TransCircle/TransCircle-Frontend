import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { limitByUnicode } from '@/utils/string'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  SectionLabel,
  Spinner,
  StatusBadge,
  Tabs,
  TextArea,
  VoteProgress,
  EDIT_REQUEST_STATUS_TONE,
  EDIT_REQUEST_STATUS_LABEL_KEYS,
  type DescriptionItem,
  type TabItem,
} from '@/components/admin'
import shell from './Page.module.css'

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

import { useFormatTs } from '@/utils/datetime'

/**
 * Safely read a proposed-change field, preferring the typed `proposed` sub-object
 * and falling back to the legacy flat field.
 */
/** @deprecated 旧扁平字段映射（迁移兼容），使用属性存在性检查替代 any 断言 */
type OldFlatFieldMap = Record<string, string | string[] | null | undefined>

function getProposedField(
  detail: EditRequestItem | null,
  nestedKey: keyof NonNullable<EditRequestItem['proposed']>,
  flatKey: string,
): string | null | undefined {
  if (!detail) return undefined
  const nested = detail.proposed?.[nestedKey]
  if (typeof nested === 'string') return nested
  if (nested === null) return null
  // 旧扁平结构回退：检查 key 存在后再读取
  const old = detail as unknown as OldFlatFieldMap
  return flatKey in detail ? (old[flatKey] as string | undefined) : undefined
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
  // 旧扁平结构回退
  const old = detail as unknown as OldFlatFieldMap
  return flatKey in detail ? (old[flatKey] as string[] | undefined) : undefined
}

export const AdminEditRequests = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, user, isAdmin, permissions } = useAuth()
  const formatTs = useFormatTs()
  const fetchSeq = useRef(0)

  // 编辑申请状态筛选：pending / approved / rejected / applied / superseded
  const [statusFilter, setStatusFilter] = useState('pending')

  const [items, setItems] = useState<EditRequestItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EditRequestItem | null>(null)
  const [voteSubmitting, setVoteSubmitting] = useState(false)
  const [voteNote, setVoteNote] = useState('')

  const fetchList = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20', status: statusFilter })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<EditRequestItem[]>(`/admin/edit-requests?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (seq !== fetchSeq.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (cursorVal) setItems((prev) => [...prev, ...result.data])
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems([])
    setCursor(null)
    fetchList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken, statusFilter])

  const fetchDetail = async (id: string) => {
    setSelectedId(id)
    setVoteNote('')
    const result = await get<EditRequestItem>(`/admin/edit-requests/${id}`)
    if (result.ok) setDetail(result.data)
    else setError(result.error.message)
  }

  const handleVote = async (vote: 'approve' | 'reject') => {
    if (!selectedId || !detail) return
    setVoteSubmitting(true)
    setError('')
    const result = await post(
      `/admin/edit-requests/${selectedId}/vote`,
      {
        vote,
        note: voteNote.trim() || null,
        expectedVersion: detail.version,
      },
      {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      },
    )
    setVoteSubmitting(false)
    if (result.ok) {
      setVoteNote('')
      fetchDetail(selectedId)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      // 与 Admin.tsx 一致：版本冲突时提示并刷新详情，使重新投票携带最新版本号
      setError(t('admin.versionConflictRefreshed'))
      fetchDetail(selectedId)
    } else {
      setError(result.error.message)
    }
  }

  if (!authLoading && (!user || !isAdmin)) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={t('adminEditRequests.accessDenied')}
          description={t('adminEditRequests.accessDeniedDetail')}
        />
      </div>
    )
  }

  if (authLoading) {
    return (
      <div className={shell.page}>
        <Spinner size="md" label={t('adminEditRequests.loading')} />
      </div>
    )
  }

  if (selectedId && detail) {
    const proposedTitle = getProposedField(detail, 'title', 'proposedTitle')
    const proposedSummary = getProposedField(detail, 'summary', 'proposedSummary')
    const proposedContent = getProposedField(detail, 'content', 'proposedContent')
    const proposedTags = getProposedFieldArray(detail, 'tags', 'proposedTags')

    const metaItems: DescriptionItem[] = [
      { term: t('adminEditRequests.contributionId'), value: detail.contribution?.id ?? detail.contributionId ?? '—' },
      {
        term: t('adminEditRequests.status'),
        value: (
          <StatusBadge
            tone={EDIT_REQUEST_STATUS_TONE[detail.status] ?? 'neutral'}
            label={t(EDIT_REQUEST_STATUS_LABEL_KEYS[detail.status] ?? detail.status)}
            size="sm"
          />
        ),
      },
      { term: t('adminEditRequests.version'), value: `v${detail.version}` },
      { term: t('adminEditRequests.created'), value: formatTs(detail.createdAt) || '—' },
    ]

    return (
      <div className={shell.page}>
        <div>
          <AdminButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedId(null)
              setDetail(null)
            }}
          >
            {t('adminEditRequests.backToList')}
          </AdminButton>
        </div>

        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('adminEditRequests.detailTitle')}</h2>

            <DescriptionList items={metaItems} columns={2} />

            <div className={shell.contentBlock}>
              <strong>{t('adminEditRequests.reason')}：</strong>
              {detail.reason}
            </div>

            {/* Votes progress */}
            {detail.votes && (
              <Card tone="subtle" padding="sm">
                <SectionLabel>{t('adminEditRequests.voteProgress')}</SectionLabel>
                <VoteProgress
                  approve={detail.votes.approve}
                  reject={detail.votes.reject}
                  required={detail.votes.required}
                  total={detail.votes.total}
                  approveLabel={t('adminEditRequests.voteApprove')}
                  rejectLabel={t('adminEditRequests.voteReject')}
                  thresholdLabel={t('adminEditRequests.votesRequired')}
                />
                {detail.myVote && (
                  <p className={shell.subtleNoteSpaced}>
                    {t('adminEditRequests.myVote')}：
                    {detail.myVote === 'approve'
                      ? t('adminEditRequests.voteApprove')
                      : t('adminEditRequests.voteReject')}
                  </p>
                )}
              </Card>
            )}

            {/* Proposed changes — prefer nested fields, fall back to flat (via type guard) */}
            {(proposedTitle || proposedSummary || proposedContent || (proposedTags && proposedTags.length > 0)) && (
              <div className={shell.stackSm}>
                {proposedTitle && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedTitle')}：</strong>
                    {proposedTitle}
                  </p>
                )}
                {proposedSummary && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedSummary')}：</strong>
                    {proposedSummary}
                  </p>
                )}
                {proposedContent && (
                  <div className={shell.contentBlock}>
                    <strong>{t('adminEditRequests.proposedContent')}：</strong>
                    <div>{proposedContent}</div>
                  </div>
                )}
                {proposedTags && proposedTags.length > 0 && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedTags')}：</strong>
                    {proposedTags.join(', ')}
                  </p>
                )}
              </div>
            )}

            {error && <Alert tone="error">{error}</Alert>}

            {detail.status === 'pending' && hasPermission(permissions, PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE) && (
              <div className={shell.stackSm}>
                <TextArea
                  value={voteNote}
                  onChange={(e) => setVoteNote(e.target.value)}
                  placeholder={t('adminEditRequests.voteNotePlaceholder')}
                />
                <div className={shell.actions}>
                  <AdminButton variant="primary" onClick={() => handleVote('approve')} loading={voteSubmitting}>
                    {t('adminEditRequests.voteApprove')}
                  </AdminButton>
                  <AdminButton variant="danger" onClick={() => handleVote('reject')} loading={voteSubmitting}>
                    {t('adminEditRequests.voteReject')}
                  </AdminButton>
                </div>
              </div>
            )}

            {detail.votes?.history && detail.votes.history.length > 0 && (
              <Card tone="subtle" padding="sm">
                <SectionLabel>{t('adminEditRequests.voteHistory')}</SectionLabel>
                <ul className={shell.history}>
                  {detail.votes.history.map((v) => (
                    <li key={v.reviewerId} className={shell.historyItem}>
                      <span className={shell.historyHead}>
                        <StatusBadge
                          tone={v.vote === 'approve' ? 'green' : 'red'}
                          label={
                            v.vote === 'approve'
                              ? t('adminEditRequests.voteApprove')
                              : t('adminEditRequests.voteReject')
                          }
                          size="sm"
                        />
                        <span>{v.note || t('adminEditRequests.noNote')}</span>
                      </span>
                      <span className={shell.historyTime}>{formatTs(v.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </Card>
      </div>
    )
  }

  const statusTabs: TabItem[] = [
    { key: 'pending', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['pending'] ?? 'statusPending') },
    { key: 'approved', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['approved'] ?? 'statusApproved') },
    { key: 'rejected', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['rejected'] ?? 'statusRejected') },
    { key: 'applied', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['applied'] ?? 'statusApplied') },
    { key: 'superseded', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['superseded'] ?? 'statusSuperseded') },
  ]

  return (
    <div className={shell.page}>
      {error && <Alert tone="error">{error}</Alert>}
      <Tabs
        items={statusTabs}
        value={statusFilter}
        onChange={setStatusFilter}
        ariaLabel={t('adminEditRequests.filterLabel')}
        variant="underline"
        panelId="edit-request-panel"
      />
      {loading && items.length === 0 ? (
        <Spinner size="md" label={t('adminEditRequests.loading')} />
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
        <ul className={shell.list}>
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className={shell.rowBtn} onClick={() => fetchDetail(item.id)}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>
                    {item.contribution?.title ??
                      `${t('adminEditRequests.contribPrefix')} ${limitByUnicode(item.contribution?.id ?? item.contributionId ?? '', 20)}…`}
                  </span>
                  <span className={shell.rowMeta}>{limitByUnicode(item.reason, 60)}</span>
                </span>
                <span className={shell.rowRight}>
                  <StatusBadge
                    tone={EDIT_REQUEST_STATUS_TONE[item.status] ?? 'neutral'}
                    label={t(EDIT_REQUEST_STATUS_LABEL_KEYS[item.status] ?? item.status)}
                    size="sm"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className={shell.loadMoreWrap}>
          <AdminButton variant="secondary" onClick={() => fetchList(cursor)} loading={loading}>
            {t('adminEditRequests.loadMore')}
          </AdminButton>
        </div>
      )}
    </div>
  )
}
