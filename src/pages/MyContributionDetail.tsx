import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { get, post, patch } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { ERRORS } from '@/api/errors'
import styles from './Admin.module.css'

// Unicode 感知的字符串截断（api.md §12 通用约定：按字符而非 UTF-16 码元计数）
function limitByUnicode(str: string, max: number): string {
  return [...str].slice(0, max).join('')
}

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

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const MyContributionDetail = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { loading: authLoading } = useAuth()
  const { t } = useTranslation()

  const STATUS_LABELS: Record<string, string> = {
    draft: t('myContributionDetail.statusDraft'), pending: t('myContributionDetail.statusPending'), in_review: t('myContributionDetail.statusInReview'),
    approved: t('myContributionDetail.statusApproved'), rejected: t('myContributionDetail.statusRejected'), published: t('myContributionDetail.statusPublished'),
    hidden: t('myContributionDetail.statusHidden'), withdrawn: t('myContributionDetail.statusWithdrawn'),
  }
  const EDITABLE_STATUSES = ['draft', 'rejected', 'withdrawn']

  const [contrib, setContrib] = useState<ContributionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [summary, setSummary] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [language, setLanguage] = useState('zh-CN')
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
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
    if (!contrib) return
    setSaving(true)
    setActionError('')
    const result = await patch(`/me/contributions/${contrib.id}`, {
      title, content, contentFormat: 'markdown',
      summary: summary || null,
      tags, language,
      expectedVersion: contrib.version,
    })
    setSaving(false)
    if (result.ok) {
      setContrib(result.data as unknown as ContributionDetail)
      setEditMode(false)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError(t('myContributionDetail.versionConflict'))
    } else {
      setActionError(result.error.message)
    }
  }

  const handleSubmit = async () => {
    if (busy.current || !contrib) return
    busy.current = true
    setActionError('')
    if (!window.confirm(t('myContributionDetail.confirmSubmit'))) { busy.current = false; return }
    const result = await post(`/me/contributions/${contrib.id}/submit`, {
      expectedVersion: contrib.version,
    })
    busy.current = false
    if (result.ok) {
      setContrib(prev => prev ? { ...prev, status: 'pending', version: (result.data as unknown as Record<string, number>).version ?? prev.version } : prev)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError(t('myContributionDetail.versionConflict'))
    } else {
      setActionError(result.error.message)
    }
  }

  const handleWithdraw = async () => {
    if (busy.current || !contrib) return
    busy.current = true
    setActionError('')
    if (!window.confirm(t('myContributionDetail.confirmWithdraw'))) { busy.current = false; return }
    const result = await post(`/me/contributions/${contrib.id}/withdraw`, {
      expectedVersion: contrib.version,
    })
    busy.current = false
    if (result.ok) {
      setContrib(prev => prev ? { ...prev, status: 'withdrawn', version: (result.data as unknown as Record<string, number>).version ?? prev.version } : prev)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError(t('myContributionDetail.versionConflict'))
    } else {
      setActionError(result.error.message)
    }
  }

  if (loading) return <main className={styles.container}><div className={styles.loading}>{t('myContributionDetail.loading')}</div></main>
  if (error || !contrib) return <main className={styles.container}><div className={styles.errorBox}>{error || t('myContributionDetail.notFound')}</div></main>

  const isEditable = EDITABLE_STATUSES.includes(contrib.status)

  return (
    <main className={styles.container}>
      <button className={styles.back} onClick={() => navigate('/me/contributions')}>
        {t('myContributionDetail.backToList')}
      </button>

      <div className={styles.detailCard}>
        {editMode ? (
          <>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t('myContributionDetail.fieldTitle')}</label>
              <input type="text" value={title} onChange={e => setTitle(limitByUnicode(e.target.value, 120))}
                className={styles.input} maxLength={120} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t('myContributionDetail.fieldContent')}</label>
              <textarea value={content} onChange={e => setContent(e.target.value)}
                className={styles.input} style={{ width: '100%', minHeight: '200px' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t('myContributionDetail.fieldSummary')}</label>
              <input type="text" value={summary} onChange={e => setSummary(e.target.value)}
                className={styles.input} maxLength={300} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t('myContributionDetail.fieldTags')}</label>
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
                {tags.map(tag => (
                  <span key={tag} style={{ background: 'var(--hover-bg)', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.85rem' }}>
                    {tag}
                    <button type="button" onClick={() => setTags(prev => prev.filter(t => t !== tag))}
                      style={{ marginLeft: '0.25rem', cursor: 'pointer', background: 'none', border: 'none', color: 'var(--error-color)', padding: 0 }}>&times;</button>
                  </span>
                ))}
              </div>
              <input type="text" value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                    e.preventDefault()
                    const tag = tagInput.trim().slice(0, 32)
                    if (!tags.includes(tag) && tags.length < 8) {
                      setTags(prev => [...prev, tag])
                    }
                    setTagInput('')
                  }
                }}
                placeholder={t('myContributionDetail.tagPlaceholder')} className={styles.input} maxLength={32}
                style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t('myContributionDetail.fieldLanguage')}</label>
              <select value={language} onChange={e => setLanguage(e.target.value)}
                className={styles.input} style={{ width: '100%' }}>
                <option value="zh-CN">zh-CN</option>
                <option value="zh-TW">zh-TW</option>
                <option value="en">en</option>
                <option value="ja">ja</option>
                <option value="other">other</option>
              </select>
            </div>
            {actionError && <p style={{ color: 'var(--error-color)', marginBottom: '0.5rem' }}>{actionError}</p>}
            <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? t('myContributionDetail.saveSubmitting') : t('myContributionDetail.saveSubmit')}
            </button>
            <button className={styles.btnSecondary} onClick={() => setEditMode(false)} style={{ marginLeft: '0.5rem' }}>{t('myContributionDetail.cancel')}</button>
          </>
        ) : (
          <>
            <h2 className={styles.detailTitle}>{contrib.title}</h2>
            <div className={styles.detailMeta}>
              {STATUS_LABELS[contrib.status] || contrib.status} · v{contrib.version}
              · {formatTs(contrib.createdAt)}
              {contrib.submittedAt ? ` · 提交于 ${formatTs(contrib.submittedAt)}` : ''}
            </div>
            {contrib.summary && <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{contrib.summary}</p>}
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--hover-bg)', padding: '1rem', borderRadius: '8px' }}>
              {contrib.contentRaw}
            </pre>
            {contrib.review.publicNote && (
              <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--hover-bg)', borderRadius: '8px' }}>
                <strong>{t('myContributionDetail.reviewNote')}：</strong>{contrib.review.publicNote}
                {contrib.review.reviewedAt && ` (${formatTs(contrib.review.reviewedAt)})`}
              </div>
            )}
            {actionError && <p style={{ color: 'var(--error-color)', marginTop: '0.5rem' }}>{actionError}</p>}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              {isEditable && (
                <button className={styles.btnPrimary} onClick={() => setEditMode(true)}>{t('myContributionDetail.edit')}</button>
              )}
              {isEditable && (
                <button className={styles.btnSecondary} onClick={handleSubmit}>{t('myContributionDetail.submitReview')}</button>
              )}
              {(contrib.status === 'pending' || contrib.status === 'in_review') && (
                <button className={styles.btnSecondary} onClick={handleWithdraw} style={{ color: 'var(--error-color)' }}>{t('myContributionDetail.withdraw')}</button>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
