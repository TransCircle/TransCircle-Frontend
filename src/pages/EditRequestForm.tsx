import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, setIntentKey, newIdempotencyKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from './Register.module.css'
import adminStyles from './Admin.module.css'

// Unicode 感知的字符串截断（api.md §12 通用约定：按字符而非 UTF-16 码元计数）
function limitByUnicode(str: string, max: number): string {
  return [...str].slice(0, max).join('')
}

export const EditRequestForm = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [reason, setReason] = useState('')
  const [proposedTitle, setProposedTitle] = useState('')
  const [proposedContent, setProposedContent] = useState('')
  const [proposedSummary, setProposedSummary] = useState('')
  const [proposedTags, setProposedTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) { setError(t('editRequest.reasonRequired')); return }
    // Trim title/summary to match send logic — prevents whitespace-only input
    // from passing validation but sending undefined (L9)
    const hasTitle = proposedTitle.trim()
    const hasContent = proposedContent
    const hasSummary = proposedSummary.trim()
    const hasTags = proposedTags.length > 0
    if (!hasTitle && !hasContent && !hasSummary && !hasTags) {
      setError(t('editRequest.atLeastOne'))
      return
    }
    setSubmitting(true)
    setError('')
    try {
      setIntentKey(newIdempotencyKey())
      const result = await post(`/contributions/${id}/edit-requests`, {
        reason: reason.trim(),
        proposedTitle: proposedTitle.trim() || undefined,
        proposedContent: proposedContent || undefined,
        proposedContentFormat: proposedContent ? 'markdown' : undefined,
        proposedSummary: proposedSummary.trim() || undefined,
        proposedTags: proposedTags.length > 0 ? proposedTags : undefined,
      }, { idempotent: true })
      if (result.ok) {
        setSuccess(true)
      } else {
        if (result.error.code === ERRORS.VALIDATION_ERROR && result.error.details) {
          const reasons = result.error.details.map(d => d.reason).join('；')
          setError(reasons || result.error.message)
        } else if (result.error.code === ERRORS.CONTRIBUTION_NOT_FOUND) {
          setError(t('editRequest.contributionNotFound'))
        } else if (result.error.code === ERRORS.CONTRIBUTION_NOT_EDITABLE) {
          setError(t('editRequest.contributionNotEditable'))
        } else if (result.error.code === ERRORS.EMAIL_NOT_VERIFIED) {
          setError(t('editRequest.emailNotVerified'))
        } else {
          setError(result.error.message)
        }
      }
    } catch {
      setError(t('editRequest.networkError'))
    } finally {
      setIntentKey(null)
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main className={adminStyles.container} style={{ textAlign: 'center', padding: '2rem' }}>
        <h2 className={adminStyles.heading}>{t('editRequest.successTitle')}</h2>
        <p>{t('editRequest.successDescription')}</p>
        <button className={adminStyles.btnPrimary} onClick={() => navigate('/')}>{t('editRequest.backToHome')}</button>
      </main>
    )
  }

  return (
    <main className={adminStyles.container}>
      <button className={adminStyles.back} onClick={() => navigate(-1)}>{t('editRequest.back')}</button>
      <h1 className={adminStyles.heading}>{t('editRequest.title')}</h1>
      <form className={formStyles.form} onSubmit={handleSubmit}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.reasonLabel')}</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)}
            className={formStyles.input} rows={3} maxLength={500} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedTitle')}</span>
          <input type="text" value={proposedTitle} onChange={e => setProposedTitle(limitByUnicode(e.target.value, 120))}
            className={formStyles.input} maxLength={120} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedContent')}</span>
          <textarea value={proposedContent} onChange={e => setProposedContent(e.target.value)}
            className={formStyles.input} rows={10} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedSummary')}</span>
          <input type="text" value={proposedSummary} onChange={e => setProposedSummary(e.target.value)}
            className={formStyles.input} maxLength={300} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedTags')}</span>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
            {proposedTags.map(tag => (
              <span key={tag} style={{ background: 'var(--hover-bg)', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.85rem' }}>
                {tag}
                <button type="button" onClick={() => setProposedTags(prev => prev.filter(t => t !== tag))}
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
                if (!proposedTags.includes(tag) && proposedTags.length < 8) {
                  setProposedTags(prev => [...prev, tag])
                }
                setTagInput('')
              }
            }}
            placeholder={t('editRequest.tagPlaceholder')} className={formStyles.input} maxLength={32} />
        </label>
        {error && <p className={formStyles.error}>{error}</p>}
        <button type="submit" disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? t('editRequest.submitting') : t('editRequest.submit')}
        </button>
      </form>
    </main>
  )
}
