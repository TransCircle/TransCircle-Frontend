import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { post, setIntentKey, newIdempotencyKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { limitByUnicode } from '@/utils/string'
import { AdminButton, Alert, Checkbox, Select, TagInput, TextArea, TextField } from '@/components/ui'
import { MarkdownField } from './MarkdownField'
import styles from './SubmitForm.module.css'

type FormStatus = 'idle' | 'submitting' | 'success' | 'error'

interface FormData {
  title: string
  content: string
  summary: string
  tags: string[]
  language: string
  submitMode: string
  agreement: boolean
}

interface FormErrors {
  title?: string
  content?: string
  summary?: string
  tags?: string
  agreement?: string
  _fallback?: string
}

const INITIAL_FORM: FormData = {
  title: '',
  content: '',
  summary: '',
  tags: [],
  language: 'zh-CN',
  submitMode: 'submit',
  agreement: false,
}

const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'other'] as const

const TAG_MAX = 8
const TAG_MAX_LENGTH = 32

const validate = (data: FormData, t: (key: string, options?: Record<string, unknown>) => string): FormErrors => {
  const errors: FormErrors = {}
  if (!data.title.trim()) errors.title = t('submit.errors.titleRequired')
  else if ([...data.title.trim()].length > 120) errors.title = t('submit.errors.titleTooLong', { max: 120 })
  if (!data.content.trim()) errors.content = t('submit.errors.contentRequired')
  else if ([...data.content.trim()].length > 50000) errors.content = t('submit.errors.contentTooLarge')
  if ([...data.summary].length > 300) errors.summary = t('submit.errors.summaryTooLong')
  if (data.tags.length > TAG_MAX) errors.tags = t('submit.errors.tagsTooMany', { max: TAG_MAX })
  for (const tag of data.tags) {
    if ([...tag].length > TAG_MAX_LENGTH) {
      errors.tags = t('submit.errors.tagTooLong', { max: TAG_MAX_LENGTH })
      break
    }
  }
  if (!data.agreement) errors.agreement = t('submit.errors.agreementRequired')
  return errors
}

export const SubmitForm = () => {
  const { t } = useTranslation()
  const { user, loading, loginProvider, loginWithGitHub, loginWithX } = useAuth()
  const [form, setForm] = useState<FormData>(INITIAL_FORM)
  const [errors, setErrors] = useState<FormErrors>({})
  const [status, setStatus] = useState<FormStatus>('idle')
  const [submitId, setSubmitId] = useState<string>('')
  const [serverError, setServerError] = useState<string>('')

  const set = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    const errorKey = key as keyof FormErrors
    if (errors[errorKey]) setErrors((prev) => ({ ...prev, [errorKey]: undefined }))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setServerError('')

    // 未登录用户不可提交投稿（api.md §3.1 要求 Authorization Bearer token）
    if (!user) {
      setServerError(t('submit.errors.loginRequired'))
      setStatus('error')
      return
    }

    // 校验邮箱状态：pending_verification 用户不可提交投稿（api.md §概述 用户状态表）
    if (user.status === 'banned') {
      setServerError(t('login.errors.banned'))
      setStatus('error')
      return
    }
    if (user.status !== 'active') {
      setServerError(t('submit.errors.emailNotVerified'))
      setStatus('error')
      return
    }

    const validationErrors = validate(form, t)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setStatus('submitting')

    try {
      setIntentKey(newIdempotencyKey())
      const body: Record<string, unknown> = {
        title: form.title,
        content: form.content,
        contentFormat: 'markdown',
        summary: form.summary.trim() || null,
        tags: form.tags,
        language: form.language,
        submitMode: form.submitMode,
      }
      const result = await post<{ id: string; status: string }>('/contributions', body, { idempotent: true })

      if (!result.ok) {
        const code = result.error.code
        if (code === ERRORS.UNAUTHORIZED) {
          setServerError(t('submit.errors.loginRequired'))
        } else if (code === ERRORS.EMAIL_NOT_VERIFIED) {
          setServerError(t('submit.errors.emailNotVerified'))
        } else if (code === ERRORS.DUPLICATE_SUBMISSION) {
          setServerError(t('submit.errors.duplicateSubmission'))
        } else if (code === ERRORS.CONTENT_TOO_LARGE) {
          setServerError(t('submit.errors.contentTooLarge'))
        } else if (code === ERRORS.VALIDATION_ERROR && result.error.details) {
          // Map API validation errors to individual form fields
          const fieldErrors: FormErrors = {}
          for (const d of result.error.details) {
            if (d.field === 'title') fieldErrors.title = d.reason
            else if (d.field === 'content') fieldErrors.content = d.reason
            else if (d.field === 'summary') fieldErrors.summary = d.reason
            else if (d.field === 'tags') fieldErrors.tags = d.reason
            else if (!fieldErrors._fallback) fieldErrors._fallback = d.reason // fallback for unrecognized fields
          }
          setErrors(fieldErrors)
          if (fieldErrors._fallback) setServerError(fieldErrors._fallback)
        } else {
          setServerError(result.error.message || t('submit.serverError'))
        }
        setStatus('error')
        return
      }

      setSubmitId(result.data.id)
      setStatus('success')
    } catch {
      setServerError(t('submit.networkError'))
      setStatus('error')
    } finally {
      setIntentKey(null)
    }
  }

  const handleReset = () => {
    setForm(INITIAL_FORM)
    setErrors({})
    setStatus('idle')
    setServerError('')
  }

  if (status === 'success') {
    return (
      <div className={styles.form}>
        <Alert tone="success">
          <span className={styles.successContent}>
            <span className={styles.successTitle}>{t('submit.success.title')}</span>
            <span className={styles.successId}>{t('submit.success.id', { id: submitId })}</span>
            <span>{t('submit.success.hint')}</span>
          </span>
        </Alert>
        <AdminButton type="button" variant="primary" fullWidth onClick={handleReset}>
          {t('submit.status.continue')}
        </AdminButton>
      </div>
    )
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {!loading && (
        <div className={styles.loginHint}>
          {user ? (
            <span className={styles.userBadge}>
              {(loginProvider === 'github' || loginProvider === 'x') && (
                <span className={styles.userProvider}>{loginProvider === 'github' ? 'GitHub' : 'X'}</span>
              )}
              <span className={styles.userName}>{user.username}</span>
              <span className={styles.userTag}>{t('submit.loggedInAs')}</span>
            </span>
          ) : (
            <span className={styles.loginActions}>
              {t('submit.loginHint')}
              <AdminButton type="button" variant="secondary" size="sm" onClick={loginWithGitHub}>
                {t('submit.loginWithGithub')}
              </AdminButton>
              <AdminButton type="button" variant="secondary" size="sm" onClick={loginWithX}>
                {t('submit.loginWithX')}
              </AdminButton>
            </span>
          )}
        </div>
      )}

      <TextField
        label={t('submit.title')}
        required
        type="text"
        value={form.title}
        onChange={(e) => set('title', limitByUnicode(e.target.value, 120))}
        placeholder={t('submit.titlePlaceholder')}
        invalid={!!errors.title}
        hint={errors.title || undefined}
      />

      <MarkdownField
        label={t('submit.content')}
        required
        value={form.content}
        onChange={(v) => set('content', v)}
        error={errors.content}
      />

      <TextArea
        label={t('submit.summary')}
        value={form.summary}
        onChange={(e) => set('summary', e.target.value)}
        placeholder={t('submit.summaryPlaceholder')}
        maxLength={300}
        rows={3}
        invalid={!!errors.summary}
        hint={errors.summary || undefined}
      />

      <TagInput
        label={t('submit.tags')}
        value={form.tags}
        onChange={(tags) => set('tags', tags)}
        maxTags={TAG_MAX}
        maxTagLength={TAG_MAX_LENGTH}
        placeholder={t('submit.tagsPlaceholder')}
        maxReachedPlaceholder={t('submit.tagsMaxReached', { max: TAG_MAX })}
        removeTagLabel={(tag) => t('submit.removeTag', { tag })}
        invalid={!!errors.tags}
        hint={errors.tags || undefined}
      />

      <Select
        label={t('submit.language')}
        value={form.language}
        onChange={(v) => set('language', v)}
        options={LANGUAGES.map((l) => ({ value: l, label: t(`submit.languages.${l}`) }))}
      />

      <Checkbox
        label={t('submit.agreement')}
        checked={form.agreement}
        onChange={(e) => set('agreement', e.target.checked)}
        invalid={!!errors.agreement}
        hint={errors.agreement || undefined}
      />

      {status === 'error' && serverError && <Alert tone="error">{serverError}</Alert>}

      <AdminButton type="submit" variant="primary" fullWidth loading={status === 'submitting'}>
        {t('submit.status.submit')}
      </AdminButton>
    </form>
  )
}
