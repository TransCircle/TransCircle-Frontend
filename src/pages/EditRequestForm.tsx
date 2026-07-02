import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, setIntentKey, newIdempotencyKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { limitByUnicode } from '@/utils/string'
import { AdminButton, Alert, Card, PageHeader, StatusScreen, TagInput, TextArea, TextField } from '@/components/ui'
import { MarkdownField } from '@/components/MarkdownField'
import shell from './Page.module.css'

export const EditRequestForm = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [reason, setReason] = useState('')
  const [proposedTitle, setProposedTitle] = useState('')
  const [proposedContent, setProposedContent] = useState('')
  const [proposedSummary, setProposedSummary] = useState('')
  const [proposedTags, setProposedTags] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  // 服务端字段级错误（L8）
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const clearFieldError = (field: string) => {
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const n = { ...prev }
        delete n[field]
        return n
      })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      setError(t('editRequest.reasonRequired'))
      return
    }
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
      const result = await post(
        `/contributions/${id}/edit-requests`,
        {
          reason: reason.trim(),
          proposedTitle: proposedTitle.trim() || undefined,
          proposedContent: proposedContent || undefined,
          proposedContentFormat: proposedContent ? 'markdown' : undefined,
          proposedSummary: proposedSummary.trim() || undefined,
          proposedTags: proposedTags.length > 0 ? proposedTags : undefined,
        },
        { idempotent: true },
      )
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
      <StatusScreen
        kind="success"
        title={t('editRequest.successTitle')}
        description={t('editRequest.successDescription')}
        actions={[{ label: t('editRequest.backToHome'), to: '/' }]}
      />
    )
  }

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <div>
        <AdminButton
          variant="ghost"
          size="sm"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
        >
          {t('editRequest.back')}
        </AdminButton>
      </div>
      <PageHeader title={t('editRequest.title')} />

      <Card>
        <form className={shell.stack} onSubmit={handleSubmit} noValidate>
          <TextArea
            label={t('editRequest.reasonLabel')}
            required
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              clearFieldError('reason')
            }}
            rows={3}
            maxLength={500}
            invalid={!!fieldErrors.reason}
            hint={fieldErrors.reason || undefined}
          />
          <TextField
            label={t('editRequest.proposedTitle')}
            value={proposedTitle}
            onChange={(e) => {
              setProposedTitle(limitByUnicode(e.target.value, 120))
              clearFieldError('proposedTitle')
            }}
            invalid={!!fieldErrors.proposedTitle}
            hint={fieldErrors.proposedTitle || undefined}
          />
          <MarkdownField
            label={t('editRequest.proposedContent')}
            value={proposedContent}
            onChange={(v) => {
              setProposedContent(v)
              clearFieldError('proposedContent')
            }}
            error={fieldErrors.proposedContent}
          />
          <TextField
            label={t('editRequest.proposedSummary')}
            value={proposedSummary}
            onChange={(e) => {
              setProposedSummary(limitByUnicode(e.target.value, 300))
              clearFieldError('proposedSummary')
            }}
            maxLength={300}
            invalid={!!fieldErrors.proposedSummary}
            hint={fieldErrors.proposedSummary || undefined}
          />
          <TagInput
            label={t('editRequest.proposedTags')}
            value={proposedTags}
            onChange={setProposedTags}
            maxTags={8}
            maxTagLength={32}
            removeTagLabel={(tag) => t('editRequest.removeTag', { tag })}
            placeholder={t('editRequest.tagPlaceholder')}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <AdminButton type="submit" variant="primary" fullWidth loading={submitting}>
            {t('editRequest.submit')}
          </AdminButton>
        </form>
      </Card>
    </div>
  )
}
