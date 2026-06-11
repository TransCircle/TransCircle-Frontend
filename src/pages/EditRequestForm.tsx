import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { post } from '@/api/client'
import styles from '../App.module.css'
import formStyles from './Register.module.css'
import adminStyles from './Admin.module.css'

export const EditRequestForm = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [reason, setReason] = useState('')
  const [proposedTitle, setProposedTitle] = useState('')
  const [proposedContent, setProposedContent] = useState('')
  const [proposedSummary, setProposedSummary] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) { setError('请填写修改原因'); return }
    if (!proposedTitle && !proposedContent && !proposedSummary) {
      setError('至少需要修改标题、内容或摘要中的一项')
      return
    }
    setSubmitting(true)
    setError('')
    const result = await post(`/contributions/${id}/edit-requests`, {
      reason: reason.trim(),
      proposedTitle: proposedTitle.trim() || undefined,
      proposedContent: proposedContent || undefined,
      proposedContentFormat: proposedContent ? 'markdown' : undefined,
      proposedSummary: proposedSummary.trim() || undefined,
    }, { idempotent: true })
    setSubmitting(false)
    if (result.ok) {
      setSuccess(true)
    } else {
      setError(result.error.message)
    }
  }

  if (success) {
    return (
      <main className={adminStyles.container} style={{ textAlign: 'center', padding: '2rem' }}>
        <h2 className={adminStyles.heading}>修改申请已提交</h2>
        <p>等待审核员投票。</p>
        <button className={adminStyles.btnPrimary} onClick={() => navigate('/')}>返回首页</button>
      </main>
    )
  }

  return (
    <main className={adminStyles.container}>
      <button className={adminStyles.back} onClick={() => navigate(-1)}>← 返回</button>
      <h1 className={adminStyles.heading}>提交修改申请</h1>
      <form className={formStyles.form} onSubmit={handleSubmit}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>修改原因 *</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)}
            className={formStyles.input} rows={3} maxLength={500} required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>建议新标题（选填）</span>
          <input type="text" value={proposedTitle} onChange={e => setProposedTitle(e.target.value)}
            className={formStyles.input} maxLength={120} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>建议新内容（选填）</span>
          <textarea value={proposedContent} onChange={e => setProposedContent(e.target.value)}
            className={formStyles.input} rows={10} />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>建议新摘要（选填）</span>
          <input type="text" value={proposedSummary} onChange={e => setProposedSummary(e.target.value)}
            className={formStyles.input} maxLength={300} />
        </label>
        {error && <p className={formStyles.error}>{error}</p>}
        <button type="submit" disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? '提交中...' : '提交修改申请'}
        </button>
      </form>
    </main>
  )
}
