import { useState, type FormEvent } from 'react'
import { MdEditor } from 'md-editor-rt'
import 'md-editor-rt/lib/style.css'
import { useTheme } from '@/context/ThemeContext'
import { useAuth } from '@/context/AuthContext'
import FormField from './FormField'
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

const validate = (data: FormData): FormErrors => {
  const errors: FormErrors = {}
  if (!data.title.trim()) errors.title = '请输入标题'
  if (!data.content.trim()) errors.content = '请输入正文'
  if (!data.category) errors.category = '请选择分类'
  if ((data.authorType === 'real' || data.authorType === 'pen_name') && !data.authorName.trim()) {
    errors.authorName = '请输入署名名称'
  }
  if (!data.agreement) errors.agreement = '请同意投稿协议'
  return errors
}

const SubmitForm = () => {
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

    const validationErrors = validate(form)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setStatus('submitting')

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`
      const res = await fetch('/v1/contributions', {
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
        setServerError(body.error?.message ?? '提交失败，请稍后重试')
        setStatus('error')
        return
      }

      setSubmitId(body.data?.id!)
      setStatus('success')
    } catch {
      setServerError('网络错误，请检查网络连接后重试')
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
        <h3 className={styles.successTitle}>投稿成功</h3>
        <p className={styles.successId}>投稿编号：{submitId}</p>
        <p className={styles.successHint}>
          请保存此编号以便查询进度。审核通过后将发表在 story.transcircle.org。
        </p>
        <button
          type="button"
          className={styles.submitButton}
          onClick={handleReset}
          style={{ marginTop: '1rem' }}
        >
          继续投稿
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
              <span className={styles.userTag}>已登录 · 投稿将关联到你的账号</span>
            </span>
          ) : (
            <span className={styles.loginActions}>
              登录后可认领投稿：
              <button type="button" className={styles.loginBtn} onClick={loginWithGitHub}>
                GitHub
              </button>
              <button type="button" className={styles.loginBtn} onClick={loginWithX}>
                X
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

      <FormField label="标题" required error={errors.title}>
        <input
          className={styles.textInput}
          type="text"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="输入故事标题"
          maxLength={200}
        />
      </FormField>

      <FormField label="正文" required error={errors.content}>
        <div className={styles.editorWrapper}>
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

      <FormField label="分类" required error={errors.category}>
        <select
          className={styles.selectInput}
          value={form.category}
          onChange={(e) => set('category', e.target.value)}
        >
          <option value="">选择分类</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="署名方式">
        <div className={styles.radioGroup}>
          {[
            { value: 'real' as const, label: '实名' },
            { value: 'pen_name' as const, label: '笔名' },
            { value: 'anonymous' as const, label: '匿名' },
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
              />
              {opt.label}
            </label>
          ))}
        </div>
      </FormField>

      {form.authorType !== 'anonymous' && (
        <FormField
          label={form.authorType === 'real' ? '真实姓名' : '笔名'}
          required
          error={errors.authorName}
        >
          <input
            className={styles.textInput}
            type="text"
            value={form.authorName}
            onChange={(e) => set('authorName', e.target.value)}
            placeholder={form.authorType === 'real' ? '输入真实姓名' : '输入笔名'}
            maxLength={50}
          />
        </FormField>
      )}

      <FormField label="联系方式（选填，仅审核人员可见）">
        <input
          className={styles.textInput}
          type="text"
          value={form.contact}
          onChange={(e) => set('contact', e.target.value)}
          placeholder="邮箱、社交媒体账号等"
          maxLength={200}
        />
      </FormField>

      <FormField label="" error={errors.agreement}>
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="agreement"
            checked={form.agreement}
            onChange={(e) => set('agreement', e.target.checked)}
          />
          <label htmlFor="agreement" className={styles.checkboxLabel}>
            我确认内容真实、原创，并授权 TransCircle 在 story.transcircle.org
            上以 CC BY-NC-SA 4.0 协议发布。我知道投稿内容将公开可见。
          </label>
        </div>
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
        {status === 'submitting' ? '提交中...' : '提交投稿'}
      </button>
    </form>
  )
}

export default SubmitForm
