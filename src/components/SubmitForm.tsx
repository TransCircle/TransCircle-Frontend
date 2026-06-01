import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { MdEditor } from 'md-editor-rt'
import 'md-editor-rt/lib/style.css'
import { useTheme } from '@/context/useTheme'
import { useAuth } from '@/context/useAuth'
import { API_BASE } from '@/config'
import { FormField } from './FormField'
import { FieldErrorConsumer } from './FieldError'
import styles from './SubmitForm.module.css'

const CATEGORIES = ['个人经历', '观点评论', '资源指南'] as const

type AuthorType = 'real' | 'pen_name' | 'anonymous'
type FormStatus = 'idle' | 'submitting' | 'success' | 'error'

interface FormData {
  title: string
  content: string
  category: string
  authorType: AuthorType
  authorName: string
  contact: string
  agreement: boolean
  website: string
}

interface FormErrors {
  title?: string
  content?: string
  category?: string
  authorName?: string
  agreement?: string
}

const INITIAL_FORM: FormData = {
  title: '',
  content: '',
  category: '',
  authorType: 'anonymous',
  authorName: '',
  contact: '',
  agreement: false,
  website: '',
}

const validate = (data: FormData, t: (key: string) => string): FormErrors => {
  const errors: FormErrors = {}
  if (!data.title.trim()) errors.title = t('submit.errors.titleRequired')
  if (!data.content.trim()) errors.content = t('submit.errors.contentRequired')
  if (!data.category) errors.category = t('submit.errors.categoryRequired')
  if ((data.authorType === 'real' || data.authorType === 'pen_name') && !data.authorName.trim()) {
    errors.authorName = t('submit.errors.authorNameRequired')
  }
  if (!data.agreement) errors.agreement = t('submit.errors.agreementRequired')
  return errors
}

export const SubmitForm = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { user, loading, accessToken, loginWithGitHub, loginWithX } = useAuth()
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

    const validationErrors = validate(form, t)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setStatus('submitting')

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`
      const res = await fetch(`${API_BASE}/contributions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: form.title,
          content: form.content,
          contentFormat: 'markdown',
          category: form.category,
          tags: form.category ? [form.category] : [],
          language: 'zh-CN',
          submitMode: 'submit',
          authorType: form.authorType,
          authorName: form.authorType !== 'anonymous' ? form.authorName : undefined,
          contact: form.contact || undefined,
          website: form.website,
        }),
      })

      const body = await res.json() as {
        data?: { id?: string; status?: string }
        error?: { code?: string; message?: string }
      }

      if (!res.ok) {
        setServerError(body.error?.message ?? t('submit.serverError'))
        setStatus('error')
        return
      }

      setSubmitId(body.data?.id ?? '')
      setStatus('success')
    } catch {
      setServerError(t('submit.networkError'))
      setStatus('error')
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
                {user.provider === 'github' ? 'GitHub' : 'X'}
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
          maxLength={200}
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
            style={{ height: '400px' }}
          />
        </div>
      </FormField>

      <FormField label={t('submit.category')} required error={errors.category}>
        <select
          className={styles.selectInput}
          value={form.category}
          onChange={(e) => set('category', e.target.value)}
        >
          <option value="">{t('submit.categoryPlaceholder')}</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label={t('submit.authorType')}>
        <FieldErrorConsumer>
          {(errorId) => (
            <div className={styles.radioGroup} role="radiogroup" aria-describedby={errorId || undefined}>
              {[
                { value: 'real' as const, label: t('submit.authorReal') },
                { value: 'pen_name' as const, label: t('submit.authorPenName') },
                { value: 'anonymous' as const, label: t('submit.authorAnonymous') },
              ].map((opt) => (
                <label key={opt.value} className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="authorType"
                    value={opt.value}
                    checked={form.authorType === opt.value}
                    onChange={() => {
                      set('authorType', opt.value)
                      if (opt.value === 'anonymous') set('authorName', '')
                    }}
                    aria-invalid={!!errorId}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          )}
        </FieldErrorConsumer>
      </FormField>

      {form.authorType !== 'anonymous' && (
        <FormField
          label={form.authorType === 'real' ? t('submit.realName') : t('submit.penName')}
          required
          error={errors.authorName}
        >
          <input
            className={styles.textInput}
            type="text"
            value={form.authorName}
            onChange={(e) => set('authorName', e.target.value)}
            placeholder={form.authorType === 'real' ? t('submit.realNamePlaceholder') : t('submit.penNamePlaceholder')}
            maxLength={50}
          />
        </FormField>
      )}

      <FormField label={t('submit.contact')}>
        <input
          className={styles.textInput}
          type="text"
          value={form.contact}
          onChange={(e) => set('contact', e.target.value)}
          placeholder={t('submit.contactPlaceholder')}
          maxLength={200}
        />
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
