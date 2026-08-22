import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { get, post, patch } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { ERRORS } from '@/api/errors'
import { limitByUnicode } from '@/utils/string'
import {
  AdminButton,
  Alert,
  Card,
  ConfirmDialog,
  Select,
  Skeleton,
  StatusBadge,
  TagInput,
  TextField,
  CONTRIB_STATUS_TONE,
} from '@/components/ui'
import { MarkdownField } from '@/components/MarkdownField'
import { useFormatTs } from '@/utils/datetime'
import shell from './Page.module.css'

interface ContributionDetail {
  id: string
  title: string
  summary: string | null
  contentRaw: string
  contentFormat: string
  tags: string[]
  language: string
  status: string
  version: number
  createdAt: number
  updatedAt: number
  submittedAt: number | null
  publishedAt: number | null
  review: {
    reviewerDisplayName: string | null
    reviewedAt: number | null
    decision: string | null
    publicNote: string | null
  }
}

const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'other'] as const
const EDITABLE_STATUSES = ['draft', 'rejected', 'withdrawn']

export const MyContributionDetail = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const { t } = useTranslation()
  const formatTs = useFormatTs()

  const STATUS_LABELS: Record<string, string> = useMemo(
    () => ({
      draft: t('myContributionDetail.statusDraft'),
      pending: t('myContributionDetail.statusPending'),
      in_review: t('myContributionDetail.statusInReview'),
      approved: t('myContributionDetail.statusApproved'),
      rejected: t('myContributionDetail.statusRejected'),
      published: t('myContributionDetail.statusPublished'),
      hidden: t('myContributionDetail.statusHidden'),
      withdrawn: t('myContributionDetail.statusWithdrawn'),
    }),
    [t],
  )

  const [contrib, setContrib] = useState<ContributionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [summary, setSummary] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [language, setLanguage] = useState('zh-CN')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const [confirmAction, setConfirmAction] = useState<'submit' | 'withdraw' | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const busy = useRef(false)

  /* 详情拉取的会话序号：换投稿、以及冲突后的重拉都会自增，只有最新一次能写回。
     写操作也捕获它，用来判断响应回来时用户是否还停在同一篇投稿上。 */
  const loadSeq = useRef(0)

  /* 写操作的归属序号。不能拿 loadSeq 兼任：冲突分支里的 fetchContrib 也会自增它，
     那样锁就永远解不开了。换投稿时（下面的 effect）自增即可作废旧操作的归属，
     旧请求返回时便不会去解掉新投稿刚上的锁。 */
  const opSeq = useRef(0)

  /* 编辑器字段的同步镜像。保存请求往返期间输入框并未冻结，用户完全可能继续改；
     响应回来时得能读到「现在」的值，闭包里那份是发请求那一刻的快照。

     镜像必须在**事件处理里同步**更新，不能用 effect：effect 是 passive 的，
     PATCH 的响应完全可能在某次输入对应的 effect 跑之前就回来，那时读到的仍是
     旧快照，代码会误判「草稿没变」而退出编辑态，刚敲的内容就此看不见了。
     下面所有 setXxx 都通过 setDraft* 走，保证 state 与镜像同一时刻改变。 */
  const draftRef = useRef({ title, content, summary, tags, language })

  const setDraftTitle = (v: string) => {
    draftRef.current = { ...draftRef.current, title: v }
    setTitle(v)
  }
  const setDraftContent = (v: string) => {
    draftRef.current = { ...draftRef.current, content: v }
    setContent(v)
  }
  const setDraftSummary = (v: string) => {
    draftRef.current = { ...draftRef.current, summary: v }
    setSummary(v)
  }
  const setDraftTags = (v: string[]) => {
    draftRef.current = { ...draftRef.current, tags: v }
    setTags(v)
  }
  const setDraftLanguage = (v: string) => {
    draftRef.current = { ...draftRef.current, language: v }
    setLanguage(v)
  }

  /**
   * 拉取投稿详情。
   *
   * `syncEditor` 为 false 时只更新 contrib（版本号、状态），**不碰**编辑器里的字段。
   * 版本冲突后就要这样刷：用户编辑框里那份还没保存的草稿必须留着，否则「保存失败」
   * 会顺手把他刚写的内容也一起抹掉。
   */
  const fetchContrib = async (syncEditor: boolean): Promise<number> => {
    const seq = ++loadSeq.current
    if (!id) return seq
    const result = await get<ContributionDetail>(`/me/contributions/${id}`)
    if (seq !== loadSeq.current) return seq // 过期响应，丢弃
    if (!result.ok) {
      setError(result.error.message)
      return seq
    }
    setContrib(result.data)
    if (syncEditor) {
      setDraftTitle(result.data.title)
      setDraftContent(result.data.contentRaw)
      setDraftSummary(result.data.summary || '')
      setDraftTags(result.data.tags || [])
      setDraftLanguage(result.data.language || 'zh-CN')
    }
    return seq
  }

  useEffect(() => {
    if (!id || authLoading || !user) return
    /* 换投稿时把上一份的**全部**痕迹清掉，理由同 PublicContributionDetail。
        不只是数据和错误：编辑态、确认弹窗、以及两个进行中锁都是上一篇的，
        留着会让 B 一进来就停在 A 的编辑界面，或者继承一把没人会释放的锁
        （A 的写请求返回时会因 seq 失效而直接丢弃，不再走到解锁那一步）。 */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContrib(null)
    setError('')
    setActionError('')
    setEditMode(false)
    setConfirmAction(null)
    setSaving(false)
    setConfirmBusy(false)
    busy.current = false
    opSeq.current++ // 作废上一篇在途写操作对锁的归属
    setLoading(true)
    const seq = loadSeq.current + 1
    void fetchContrib(true).finally(() => {
      if (seq === loadSeq.current) setLoading(false)
    })
    // fetchContrib 每次渲染都是新函数，不能进依赖数组；它读的 id 与本 effect 同源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, authLoading, user])

  const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

  /** 编辑器里现在的内容是否仍是这次提交出去的那一份。 */
  const draftUnchanged = (sent: { title: string; content: string; summary: string; tags: string[]; language: string }) => {
    const cur = draftRef.current
    return (
      cur.title === sent.title &&
      cur.content === sent.content &&
      cur.summary === sent.summary &&
      cur.language === sent.language &&
      sameTags(cur.tags, sent.tags)
    )
  }

  const handleSave = async () => {
    if (busy.current || !contrib) return
    const session = loadSeq.current
    const myOp = ++opSeq.current
    const sent = { title, content, summary, tags, language }
    busy.current = true
    setSaving(true)
    setActionError('')
    try {
      const result = await patch(`/me/contributions/${contrib.id}`, {
        title: sent.title,
        content: sent.content,
        contentFormat: 'markdown',
        summary: sent.summary || null,
        tags: sent.tags,
        language: sent.language,
        expectedVersion: contrib.version,
      })
      // 用户已经换到另一篇投稿：这条响应与屏幕上的内容无关，一个字都不能写回
      if (loadSeq.current !== session) return
      if (result.ok) {
        setContrib(result.data as unknown as ContributionDetail)
        /* 只有草稿仍是提交出去的那一份时才退出编辑态。请求往返期间用户可能又改了几笔，
           那些改动并没有保存——直接关掉编辑器会让他以为全都存好了。 */
        if (draftUnchanged(sent)) setEditMode(false)
        else setActionError(t('myContributionDetail.savedButDraftChanged'))
      } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
        /* 必须把最新版本号拉回来：不拉的话 contrib.version 还是旧的，再点一次保存
           仍带着同一个 expectedVersion，用户会永远撞在同一堵墙上，只能退出页面重进。
           syncEditor=false —— 他编辑框里的草稿不能被服务端内容覆盖。
           重拉必须在解锁之前完成（见 finally），否则他能在版本号还没更新时再点一次。 */
        const refreshedSeq = await fetchContrib(false)
        if (loadSeq.current === refreshedSeq) setActionError(t('myContributionDetail.versionConflict'))
      } else {
        setActionError(result.error.message)
      }
    } finally {
      /* 锁在这里才释放：冲突重拉是 await 的一部分，提前解锁会让用户在版本号
         还没更新时再点一次保存，必然又是同一个冲突。
         只有仍持有归属时才释放——用户可能已经换到另一篇并发起了新的保存，
         那把锁属于新的那一次。 */
      if (opSeq.current === myOp) {
        setSaving(false)
        busy.current = false
      }
    }
  }

  const runConfirm = async () => {
    if (busy.current || !contrib || !confirmAction) return
    const session = loadSeq.current
    const myOp = ++opSeq.current
    busy.current = true
    setConfirmBusy(true)
    setActionError('')
    const endpoint = confirmAction === 'submit' ? 'submit' : 'withdraw'
    const nextStatus = confirmAction === 'submit' ? 'pending' : 'withdrawn'
    try {
      const result = await post(`/me/contributions/${contrib.id}/${endpoint}`, {
        expectedVersion: contrib.version,
      })
      // 用户已经换到另一篇投稿：这条响应与屏幕上的内容无关
      if (loadSeq.current !== session) return
      setConfirmAction(null)
      if (result.ok) {
        setContrib((prev) =>
          prev
            ? {
                ...prev,
                status: nextStatus,
                version: (result.data as unknown as Record<string, number>).version ?? prev.version,
              }
            : prev,
        )
      } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
        // 提交/撤回没有未保存的草稿，整份同步回来即可（含编辑器字段）
        const refreshedSeq = await fetchContrib(true)
        if (loadSeq.current === refreshedSeq) setActionError(t('myContributionDetail.versionConflict'))
      } else {
        setActionError(result.error.message)
      }
    } finally {
      // 同 handleSave：冲突重拉完成之后才解锁，且只有仍持有归属时才释放
      if (opSeq.current === myOp) {
        busy.current = false
        setConfirmBusy(false)
      }
    }
  }

  if (loading) {
    // 保留页面框架（返回按钮 + 卡片容器），仅内容区骨架占位，避免整页替换为 Spinner 的布局跳变
    return (
      <div className={`${shell.page} ${shell.pageNarrow}`}>
        <div>
          <AdminButton variant="ghost" size="sm" disabled>
            {t('myContributionDetail.backToList')}
          </AdminButton>
        </div>
        <Skeleton variant="card" />
      </div>
    )
  }

  if (error || !contrib) {
    return (
      <div className={`${shell.page} ${shell.pageNarrow}`}>
        <Alert tone="error">{error || t('myContributionDetail.notFound')}</Alert>
      </div>
    )
  }

  const isEditable = EDITABLE_STATUSES.includes(contrib.status)
  const canWithdraw = contrib.status === 'pending' || contrib.status === 'in_review'

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <div>
        <AdminButton variant="ghost" size="sm" onClick={() => navigate('/me/contributions')}>
          {t('myContributionDetail.backToList')}
        </AdminButton>
      </div>

      <Card>
        {editMode ? (
          <div className={shell.stack}>
            <TextField
              label={t('myContributionDetail.fieldTitle')}
              required
              value={title}
              onChange={(e) => setDraftTitle(limitByUnicode(e.target.value, 120))}
            />
            <MarkdownField
              label={t('myContributionDetail.fieldContent')}
              required
              value={content}
              onChange={setDraftContent}
            />
            <TextField
              label={t('myContributionDetail.fieldSummary')}
              value={summary}
              onChange={(e) => setDraftSummary(e.target.value)}
              maxLength={300}
            />
            <TagInput
              label={t('myContributionDetail.fieldTags')}
              value={tags}
              onChange={setDraftTags}
              maxTags={8}
              maxTagLength={32}
              removeTagLabel={(tag) => t('myContributionDetail.removeTag', { tag })}
              placeholder={t('myContributionDetail.tagPlaceholder')}
            />
            <Select
              label={t('myContributionDetail.fieldLanguage')}
              value={language}
              onChange={setDraftLanguage}
              options={LANGUAGES.map((l) => ({ value: l, label: t(`submit.languages.${l}`) }))}
            />
            {actionError && <Alert tone="error">{actionError}</Alert>}
            <div className={shell.actions}>
              <AdminButton variant="primary" loading={saving} onClick={handleSave}>
                {t('myContributionDetail.saveSubmit')}
              </AdminButton>
              {/* 保存在途时禁用：PATCH 已经发出去且没有中止手段，此时「取消」
                   只会退出编辑态，改动照样落库——用户会以为自己放弃了这次修改。 */}
              <AdminButton variant="secondary" disabled={saving} onClick={() => setEditMode(false)}>
                {t('myContributionDetail.cancel')}
              </AdminButton>
            </div>
          </div>
        ) : (
          <div className={shell.stack}>
            <div className={shell.detailHead}>
              <h1 className={shell.detailTitle}>{contrib.title}</h1>
              <StatusBadge
                tone={CONTRIB_STATUS_TONE[contrib.status] ?? 'neutral'}
                label={STATUS_LABELS[contrib.status] || contrib.status}
              />
            </div>
            <div className={shell.metaRow}>
              <span className={shell.metaItem}>v{contrib.version}</span>
              <span className={shell.metaItem}>{formatTs(contrib.createdAt)}</span>
              {contrib.submittedAt && (
                <span className={shell.metaItem}>
                  {t('myContributionDetail.submittedAt', { time: formatTs(contrib.submittedAt) })}
                </span>
              )}
            </div>
            {contrib.summary && <p className={shell.summary}>{contrib.summary}</p>}
            <div className={shell.contentBlock}>{contrib.contentRaw}</div>
            {contrib.review.publicNote && (
              <div className={shell.contentBlock}>
                <strong>{t('myContributionDetail.reviewNote')}：</strong>
                {contrib.review.publicNote}
                {contrib.review.reviewedAt && ` (${formatTs(contrib.review.reviewedAt)})`}
              </div>
            )}
            {actionError && <Alert tone="error">{actionError}</Alert>}
            <div className={shell.actions}>
              {isEditable && (
                <AdminButton variant="primary" onClick={() => setEditMode(true)}>
                  {t('myContributionDetail.edit')}
                </AdminButton>
              )}
              {isEditable && (
                <AdminButton variant="secondary" onClick={() => setConfirmAction('submit')}>
                  {t('myContributionDetail.submitReview')}
                </AdminButton>
              )}
              {canWithdraw && (
                <AdminButton variant="danger" onClick={() => setConfirmAction('withdraw')}>
                  {t('myContributionDetail.withdraw')}
                </AdminButton>
              )}
            </div>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction === 'withdraw' ? t('myContributionDetail.withdraw') : t('myContributionDetail.submitReview')
        }
        message={
          confirmAction === 'withdraw'
            ? t('myContributionDetail.confirmWithdraw')
            : t('myContributionDetail.confirmSubmit')
        }
        confirmText={
          confirmAction === 'withdraw' ? t('myContributionDetail.withdraw') : t('myContributionDetail.submitReview')
        }
        cancelText={t('myContributionDetail.cancel')}
        variant={confirmAction === 'withdraw' ? 'danger' : 'default'}
        confirmLoading={confirmBusy}
        onConfirm={runConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
