import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, setIntentKey, newIdempotencyKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { limitByUnicode } from '@/utils/string'
import styles from '../App.module.css'
import formStyles from '../components/Form.module.css'
import adminStyles from './Admin.module.css'

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
  // 服务端字段级错误（L8）
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const clearFieldError = (field: string) => () => {
    if (fieldErrors[field]) {
      setFieldErrors(prev => { const n = { ...prev }; delete n[field]; return n })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) { setError(t('editRequest.reasonRequired')); return }
    // Trim title/summary to match send logic — prevents whitespace-only input
    // from passing validation but sending undefined (L9)
    const trimmedTitle = proposedTitle.trim()
    const hasTitle = trimmedTitle
    const hasContent = proposedContent
    const trimmedSummary = proposedSummary.trim()
    const hasSummary = trimmedSummary
    const hasTags = proposedTags.length > 0
    if (!hasTitle && !hasContent && !hasSummary && !hasTags) {
      setError(t('editRequest.atLeastOne'))
      return
    }
    if ([...trimmedTitle].length > 120) {
      setError(t('editRequest.titleTooLong', { max: 120 }))
      return
    }
    if ([...trimmedSummary].length > 300) {
      setError(t('editRequest.summaryTooLong', { max: 300 }))
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
          // 映射服务端字段错误到表单字段（L8）
          const newFieldErrors: Record<string, string> = {}
          let genericMsg = ''
          for (const d of result.error.details) {
            if (['reason', 'proposedTitle', 'proposedContent', 'proposedSummary', 'proposedTags'].includes(d.field)) {
              newFieldErrors[d.field] = d.reason
            } else {
              genericMsg += (genericMsg ? '；' : '') + `${d.field}: ${d.reason}`
            }
          }
          setFieldErrors(newFieldErrors)
          setError(genericMsg || result.error.message || t('editRequest.validationFailed'))
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
      <button className={adminStyles.back} onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}>{t('editRequest.back')}</button>
      <h1 className={adminStyles.heading}>{t('editRequest.title')}</h1>
      <form className={formStyles.form} onSubmit={handleSubmit}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.reasonLabel')}</span>
          <textarea value={reason} onChange={e => { setReason(e.target.value); clearFieldError('reason')() }}
            className={formStyles.input} rows={3} maxLength={500} required aria-invalid={!!fieldErrors.reason} />
          {fieldErrors.reason && <span className={formStyles.error} role="alert">{fieldErrors.reason}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedTitle')}</span>
          <input type="text" value={proposedTitle} onChange={e => { setProposedTitle(limitByUnicode(e.target.value, 120)); clearFieldError('proposedTitle')() }}
            className={formStyles.input} aria-invalid={!!fieldErrors.proposedTitle} />
          {fieldErrors.proposedTitle && <span className={formStyles.error} role="alert">{fieldErrors.proposedTitle}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedContent')}</span>
          <textarea value={proposedContent} onChange={e => { setProposedContent(e.target.value); clearFieldError('proposedContent')() }}
            className={formStyles.input} rows={10} aria-invalid={!!fieldErrors.proposedContent} />
          {fieldErrors.proposedContent && <span className={formStyles.error} role="alert">{fieldErrors.proposedContent}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedSummary')}</span>
          <input type="text" value={proposedSummary} onChange={e => { setProposedSummary(limitByUnicode(e.target.value, 300)); clearFieldError('proposedSummary')() }}
            className={formStyles.input} maxLength={300} aria-invalid={!!fieldErrors.proposedSummary} />
          {fieldErrors.proposedSummary && <span className={formStyles.error} role="alert">{fieldErrors.proposedSummary}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('editRequest.proposedTags')}</span>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
            {proposedTags.map(tag => (
              <span key={tag} style={{ background: 'var(--hover-bg)', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.85rem' }}>
                {tag}
                <button type="button" aria-label={t('editRequest.removeTag', { tag })} onClick={() => setProposedTags(prev => prev.filter(t => t !== tag))}
                  style={{ marginLeft: '0.25rem', cursor: 'pointer', background: 'none', border: 'none', color: 'var(--error-color)', padding: 0 }}>&times;</button>
              </span>
            ))}
          </div>
          <input type="text" value={tagInput}
            onChange={e => setTagInput(limitByUnicode(e.target.value, 32))}
            onKeyDown={e => {
              if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                e.preventDefault()
                const tag = [...tagInput.trim()].slice(0, 32).join('')
                if (!proposedTags.includes(tag) && proposedTags.length < 8) {
                  setProposedTags(prev => [...prev, tag])
                }
                setTagInput('')
              }
            }}
            placeholder={t('editRequest.tagPlaceholder')} className={formStyles.input} />
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
