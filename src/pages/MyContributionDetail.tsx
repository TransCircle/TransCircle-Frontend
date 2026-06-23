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
  Spinner,
  StatusBadge,
  TagInput,
  TextArea,
  TextField,
  CONTRIB_STATUS_TONE,
} from '@/components/ui'
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
  const { loading: authLoading } = useAuth()
  const { t } = useTranslation()
  const formatTs = useFormatTs()

  const STATUS_LABELS: Record<string, string> = useMemo(() => ({
    draft: t('myContributionDetail.statusDraft'), pending: t('myContributionDetail.statusPending'), in_review: t('myContributionDetail.statusInReview'),
    approved: t('myContributionDetail.statusApproved'), rejected: t('myContributionDetail.statusRejected'), published: t('myContributionDetail.statusPublished'),
    hidden: t('myContributionDetail.statusHidden'), withdrawn: t('myContributionDetail.statusWithdrawn'),
  }), [t])

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

  useEffect(() => {
    if (!id || authLoading) return
    const load = async () => {
      const result = await get<ContributionDetail>(`/me/contributions/${id}`)
      if (result.ok) {
        setContrib(result.data)
        setTitle(result.data.title)
        setContent(result.data.contentRaw)
        setSummary(result.data.summary || '')
        setTags(result.data.tags || [])
        setLanguage(result.data.language || 'zh-CN')
      } else {
        setError(result.error.message)
      }
      setLoading(false)
    }
    load()
  }, [id, authLoading])

  const handleSave = async () => {
    if (busy.current || !contrib) return
    busy.current = true
    setSaving(true)
    setActionError('')
    const result = await patch(`/me/contributions/${contrib.id}`, {
      title, content, contentFormat: 'markdown',
      summary: summary || null,
      tags, language,
      expectedVersion: contrib.version,
    })
    setSaving(false)
    busy.current = false
    if (result.ok) {
      setContrib(result.data as unknown as ContributionDetail)
      setEditMode(false)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError(t('myContributionDetail.versionConflict'))
    } else {
      setActionError(result.error.message)
    }
  }

  const runConfirm = async () => {
    if (busy.current || !contrib || !confirmAction) return
    busy.current = true
    setConfirmBusy(true)
    setActionError('')
    const endpoint = confirmAction === 'submit' ? 'submit' : 'withdraw'
    const nextStatus = confirmAction === 'submit' ? 'pending' : 'withdrawn'
    const result = await post(`/me/contributions/${contrib.id}/${endpoint}`, {
      expectedVersion: contrib.version,
    })
    busy.current = false
    setConfirmBusy(false)
    setConfirmAction(null)
    if (result.ok) {
      setContrib(prev => prev ? { ...prev, status: nextStatus, version: (result.data as unknown as Record<string, number>).version ?? prev.version } : prev)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError(t('myContributionDetail.versionConflict'))
    } else {
      setActionError(result.error.message)
    }
  }

  if (loading) {
    return (
      <div className={`${shell.page} ${shell.pageNarrow}`}>
        <Spinner size="lg" label={t('myContributionDetail.loading')} />
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
              onChange={(e) => setTitle(limitByUnicode(e.target.value, 120))}
            />
            <TextArea
              label={t('myContributionDetail.fieldContent')}
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
            />
            <TextField
              label={t('myContributionDetail.fieldSummary')}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={300}
            />
            <TagInput
              label={t('myContributionDetail.fieldTags')}
              value={tags}
              onChange={setTags}
              maxTags={8}
              maxTagLength={32}
              removeTagLabel={(tag) => t('myContributionDetail.removeTag', { tag })}
              placeholder={t('myContributionDetail.tagPlaceholder')}
            />
            <Select
              label={t('myContributionDetail.fieldLanguage')}
              value={language}
              onChange={setLanguage}
              options={LANGUAGES.map((l) => ({ value: l, label: t(`submit.languages.${l}`) }))}
            />
            {actionError && <Alert tone="error">{actionError}</Alert>}
            <div className={shell.actions}>
              <AdminButton variant="primary" loading={saving} onClick={handleSave}>
                {t('myContributionDetail.saveSubmit')}
              </AdminButton>
              <AdminButton variant="secondary" onClick={() => setEditMode(false)}>
                {t('myContributionDetail.cancel')}
              </AdminButton>
            </div>
          </div>
        ) : (
          <div className={shell.stack}>
            <div className={shell.detailHead}>
              <h1 className={shell.detailTitle}>{contrib.title}</h1>
              <StatusBadge tone={CONTRIB_STATUS_TONE[contrib.status] ?? 'neutral'} label={STATUS_LABELS[contrib.status] || contrib.status} />
            </div>
            <div className={shell.metaRow}>
              <span className={shell.metaItem}>v{contrib.version}</span>
              <span className={shell.metaItem}>{formatTs(contrib.createdAt)}</span>
              {contrib.submittedAt && (
                <span className={shell.metaItem}>{t('myContributionDetail.submittedAt', { time: formatTs(contrib.submittedAt) })}</span>
              )}
            </div>
            {contrib.summary && <p className={shell.subtleNote}>{contrib.summary}</p>}
            <div className={shell.contentBlock}>{contrib.contentRaw}</div>
            {contrib.review.publicNote && (
              <div className={shell.contentBlock}>
                <strong>{t('myContributionDetail.reviewNote')}：</strong>{contrib.review.publicNote}
                {contrib.review.reviewedAt && ` (${formatTs(contrib.review.reviewedAt)})`}
              </div>
            )}
            {actionError && <Alert tone="error">{actionError}</Alert>}
            <div className={shell.actions}>
              {isEditable && (
                <AdminButton variant="primary" onClick={() => setEditMode(true)}>{t('myContributionDetail.edit')}</AdminButton>
              )}
              {isEditable && (
                <AdminButton variant="secondary" onClick={() => setConfirmAction('submit')}>{t('myContributionDetail.submitReview')}</AdminButton>
              )}
              {canWithdraw && (
                <AdminButton variant="danger" onClick={() => setConfirmAction('withdraw')}>{t('myContributionDetail.withdraw')}</AdminButton>
              )}
            </div>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'withdraw' ? t('myContributionDetail.withdraw') : t('myContributionDetail.submitReview')}
        message={confirmAction === 'withdraw' ? t('myContributionDetail.confirmWithdraw') : t('myContributionDetail.confirmSubmit')}
        confirmText={confirmAction === 'withdraw' ? t('myContributionDetail.withdraw') : t('myContributionDetail.submitReview')}
        cancelText={t('myContributionDetail.cancel')}
        variant={confirmAction === 'withdraw' ? 'danger' : 'default'}
        confirmLoading={confirmBusy}
        onConfirm={runConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
