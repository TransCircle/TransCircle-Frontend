import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { MdEditor } from 'md-editor-rt'
import 'md-editor-rt/lib/style.css'
import { useTheme } from '@/context/useTheme'
import { useAuth } from '@/context/useAuth'
import { post, setIntentKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { FormField } from './FormField'
import { FieldErrorConsumer } from './FieldError'
import { ImageUploader } from './ImageUploader'
import styles from './SubmitForm.module.css'

type FormStatus = 'idle' | 'submitting' | 'success' | 'error'

interface FormData {
  title: string
  content: string
  summary: string
  tags: string[]
  tagInput: string
  language: string
  submitMode: string
  agreement: boolean
  website: string
}

interface FormErrors {
  title?: string
  content?: string
  summary?: string
  tags?: string
  agreement?: string
}

const INITIAL_FORM: FormData = {
  title: '',
  content: '',
  summary: '',
  tags: [],
  tagInput: '',
  language: 'zh-CN',
  submitMode: 'submit',
  agreement: false,
  website: '',
}

const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'other'] as const

const TAG_MAX = 8
const TAG_MAX_LENGTH = 32

const validate = (data: FormData, t: (key: string, options?: Record<string, unknown>) => string): FormErrors => {
  const errors: FormErrors = {}
  if (!data.title.trim()) errors.title = t('submit.errors.titleRequired')
  else if ([...data.title.trim()].length > 120) errors.title = '标题不超过 120 个字符'
  if (!data.content.trim()) errors.content = t('submit.errors.contentRequired')
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
  const { theme } = useTheme()
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

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (!tag) return
    if ([...tag].length > TAG_MAX_LENGTH) return
    if (form.tags.length >= TAG_MAX) return
    if (form.tags.includes(tag)) return
    set('tags', [...form.tags, tag])
    set('tagInput', '')
  }

  const removeTag = (tag: string) => {
    set('tags', form.tags.filter((t) => t !== tag))
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(form.tagInput)
    }
    if (e.key === 'Backspace' && !form.tagInput && form.tags.length > 0) {
      removeTag(form.tags[form.tags.length - 1]!)
    }
  }

  const handleImageUploaded = (url: string) => {
    setForm(prev => ({ ...prev, content: prev.content + `\n![image](${url})\n` }))
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
      setIntentKey(crypto.randomUUID())  // Per-intent idempotency-key (M9)
      const result = await post<{ id: string; status: string }>('/contributions', {
        title: form.title,
        content: form.content,
        contentFormat: 'markdown',
        summary: form.summary.trim() || null,
        tags: form.tags,
        language: form.language,
        submitMode: form.submitMode,
        website: form.website, // honeypot: bots fill this, humans don't
      }, { idempotent: true })

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
            else fieldErrors.title = d.reason // fallback: show first unrecognized field's reason
          }
          setErrors(fieldErrors)
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
      <div className={styles.successBox}>
        <h3 className={styles.successTitle}>{t('submit.success.title')}</h3>
        <p className={styles.successId}>{t('submit.success.id', { id: submitId })}</p>
        <p className={styles.successHint}>
          {t('submit.success.hint')}
        </p>
        <button
          type="button"
          className={styles.submitButton}
          onClick={handleReset}
          style={{ marginTop: '1rem' }}
        >
          {t('submit.status.continue')}
        </button>
      </div>
    )
  }

  const editorTheme = theme === 'dark' ? 'dark' : 'light'

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {!loading && (
        <div className={styles.loginHint}>
          {user ? (
            <span className={styles.userBadge}>
              <span className={styles.userProvider}>
                {loginProvider === 'github' ? 'GitHub' : loginProvider === 'x' ? 'X' : ''}
              </span>
              <span className={styles.userName}>{user.username}</span>
              <span className={styles.userTag}>{t('submit.loggedInAs')}</span>
            </span>
          ) : (
            <span className={styles.loginActions}>
              {t('submit.loginHint')}
              <button type="button" className={styles.loginBtn} onClick={loginWithGitHub}>
                {t('submit.loginWithGithub')}
              </button>
              <button type="button" className={styles.loginBtn} onClick={loginWithX}>
                {t('submit.loginWithX')}
              </button>
            </span>
          )}
        </div>
      )}

      {/* Honeypot: hidden from users, filled by bots */}
      <input
        type="text"
        name="website"
        className={styles.honeypot}
        tabIndex={-1}
        autoComplete="off"
        value={form.website}
        onChange={(e) => set('website', e.target.value)}
      />

      <FormField label={t('submit.title')} required error={errors.title}>
        <input
          className={styles.textInput}
          type="text"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder={t('submit.titlePlaceholder')}
          maxLength={120}
        />
      </FormField>

      <FormField label={t('submit.content')} required error={errors.content} htmlFor="submit-content">
        <div className={styles.editorWrapper} id="submit-content">
          <MdEditor
            value={form.content}
            onChange={(v: string) => set('content', v)}
            theme={editorTheme}
            language="zh-CN"
            preview={true}
            toolbarsExclude={['image', 'link', 'mermaid', 'katex', 'github']}
          />
          <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ImageUploader onUploaded={handleImageUploaded} />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              上传图片后自动在编辑器中插入 Markdown 引用
            </span>
          </div>
        </div>
      </FormField>

      <FormField label={t('submit.summary')} error={errors.summary}>
        <textarea
          className={styles.textInput}
          value={form.summary}
          onChange={(e) => set('summary', e.target.value)}
          placeholder={t('submit.summaryPlaceholder')}
          maxLength={300}
          rows={3}
          style={{ resize: 'vertical' }}
        />
      </FormField>

      <FormField label={t('submit.tags')} error={errors.tags} htmlFor="submit-tags">
        <div className={styles.tagInputWrapper}>
          <div className={styles.tagList}>
            {form.tags.map((tag) => (
              <span key={tag} className={styles.tagChip}>
                {tag}
                <button
                  type="button"
                  className={styles.tagRemove}
                  onClick={() => removeTag(tag)}
                  aria-label={t('submit.removeTag', { tag })}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
          <FieldErrorConsumer>
            {(errorId) => (
              <input
                id="submit-tags"
                className={styles.tagInput}
                type="text"
                value={form.tagInput}
                onChange={(e) => set('tagInput', e.target.value)}
                onKeyDown={handleTagKeyDown}
                placeholder={form.tags.length >= TAG_MAX ? t('submit.tagsMaxReached', { max: TAG_MAX }) : t('submit.tagsPlaceholder')}
                disabled={form.tags.length >= TAG_MAX}
                aria-invalid={!!errors.tags}
                aria-describedby={errorId || undefined}
              />
            )}
          </FieldErrorConsumer>
        </div>
      </FormField>

      <FormField label={t('submit.language')}>
        <select
          className={styles.selectInput}
          value={form.language}
          onChange={(e) => set('language', e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {t(`submit.languages.${lang}`)}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="" error={errors.agreement}>
        <FieldErrorConsumer>
          {(errorId) => (
            <div className={styles.checkboxRow}>
              <input
                type="checkbox"
                id="agreement"
                checked={form.agreement}
                onChange={(e) => set('agreement', e.target.checked)}
                aria-describedby={errorId || undefined}
                aria-invalid={!!errorId}
              />
              <label htmlFor="agreement" className={styles.checkboxLabel}>
                {t('submit.agreement')}
              </label>
            </div>
          )}
        </FieldErrorConsumer>
      </FormField>

      {status === 'error' && serverError && (
        <div className={styles.errorBox} role="alert">
          <p className={styles.errorText}>{serverError}</p>
        </div>
      )}

      <button
        type="submit"
        className={styles.submitButton}
        disabled={status === 'submitting'}
      >
        {status === 'submitting' ? t('submit.status.submitting') : t('submit.status.submit')}
      </button>
    </form>
  )
}

