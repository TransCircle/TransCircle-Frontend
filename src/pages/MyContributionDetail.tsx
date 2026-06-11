import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post, patch } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { ERRORS } from '@/api/errors'
import styles from './Admin.module.css'

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

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', pending: '待审核', in_review: '审核中',
  approved: '已通过', rejected: '未通过', published: '已发布',
  hidden: '已隐藏', withdrawn: '已撤回',
}

const EDITABLE_STATUSES = ['draft', 'rejected', 'withdrawn']

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const MyContributionDetail = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { loading: authLoading } = useAuth()
  void useTranslation()

  const [contrib, setContrib] = useState<ContributionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!id || authLoading) return
    const load = async () => {
      const result = await get<ContributionDetail>(`/me/contributions/${id}`)
      if (result.ok) {
        setContrib(result.data)
        setTitle(result.data.title)
        setContent(result.data.contentRaw)
        setSummary(result.data.summary || '')
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
      expectedVersion: contrib.version,
    })
    setSaving(false)
    if (result.ok) {
      setContrib(result.data as unknown as ContributionDetail)
      setEditMode(false)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError('版本冲突，请刷新后重试')
    } else {
      setActionError(result.error.message)
    }
  }

  const handleSubmit = async () => {
    if (!contrib) return
    if (!window.confirm('确定提交该草稿进行审核？')) return
    const result = await post(`/me/contributions/${contrib.id}/submit`, {
      expectedVersion: contrib.version,
    })
    if (result.ok) {
      setContrib(prev => prev ? { ...prev, status: 'pending', version: (result.data as unknown as Record<string, number>).version ?? prev.version } : prev)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError('版本冲突，请刷新后重试')
    } else {
      setActionError(result.error.message)
    }
  }

  const handleWithdraw = async () => {
    if (!contrib) return
    if (!window.confirm('确定撤回该投稿？')) return
    const result = await post(`/me/contributions/${contrib.id}/withdraw`, {
      expectedVersion: contrib.version,
    })
    if (result.ok) {
      setContrib(prev => prev ? { ...prev, status: 'withdrawn', version: (result.data as unknown as Record<string, number>).version ?? prev.version } : prev)
    } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
      setActionError('版本冲突，请刷新后重试')
    } else {
      setActionError(result.error.message)
    }
  }

  if (loading) return <main className={styles.container}><div className={styles.loading}>加载中...</div></main>
  if (error || !contrib) return <main className={styles.container}><div className={styles.errorBox}>{error || '投稿不存在'}</div></main>

  const isEditable = EDITABLE_STATUSES.includes(contrib.status)

  return (
    <main className={styles.container}>
      <button className={styles.back} onClick={() => navigate('/me/contributions')}>
        ← 返回列表
      </button>

      <div className={styles.detailCard}>
        {editMode ? (
          <>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>标题</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                className={styles.input} maxLength={120} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>内容</label>
              <textarea value={content} onChange={e => setContent(e.target.value)}
                className={styles.input} style={{ width: '100%', minHeight: '200px' }} />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>摘要</label>
              <input type="text" value={summary} onChange={e => setSummary(e.target.value)}
                className={styles.input} maxLength={300} style={{ width: '100%' }} />
            </div>
            {actionError && <p style={{ color: '#c62828', marginBottom: '0.5rem' }}>{actionError}</p>}
            <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存修改'}
            </button>
            <button className={styles.btnSecondary} onClick={() => setEditMode(false)} style={{ marginLeft: '0.5rem' }}>取消</button>
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
              <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#fff3e0', borderRadius: '8px' }}>
                <strong>审核备注：</strong>{contrib.review.publicNote}
                {contrib.review.reviewedAt && ` (${formatTs(contrib.review.reviewedAt)})`}
              </div>
            )}
            {actionError && <p style={{ color: '#c62828', marginTop: '0.5rem' }}>{actionError}</p>}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              {isEditable && (
                <button className={styles.btnPrimary} onClick={() => setEditMode(true)}>编辑</button>
              )}
              {isEditable && (
                <button className={styles.btnSecondary} onClick={handleSubmit}>提交审核</button>
              )}
              {(contrib.status === 'pending' || contrib.status === 'in_review') && (
                <button className={styles.btnSecondary} onClick={handleWithdraw} style={{ color: '#c62828' }}>撤回</button>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
