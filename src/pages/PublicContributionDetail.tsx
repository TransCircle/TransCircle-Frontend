import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { get } from '@/api/client'
import styles from './Admin.module.css'

interface PublicDetail {
  id: string
  title: string
  summary: string | null
  contentHtml: string
  contentFormat: string
  tags: string[]
  language: string
  author: {
    displayName: string
    avatarUrl: string | null
  }
  publishedAt: number
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const PublicContributionDetail = () => {
  const { id } = useParams<{ id: string }>()

  const [detail, setDetail] = useState<PublicDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    const load = async () => {
      const result = await get<PublicDetail>(`/public/contributions/${id}`)
      if (result.ok) {
        setDetail(result.data)
      } else {
        setError('投稿不存在或未发布')
      }
      setLoading(false)
    }
    load()
  }, [id])

  if (loading) return <main className={styles.container}><div className={styles.loading}>加载中...</div></main>
  if (error || !detail) return <main className={styles.container}><div className={styles.errorBox}>{error || '投稿不存在'}</div></main>

  return (
    <main className={styles.container}>
      <Link to="/" className={styles.back}>← 返回首页</Link>

      <article className={styles.detailCard}>
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem' }}>{detail.title}</h1>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          作者: {detail.author.displayName} · {formatTs(detail.publishedAt)} · {detail.language}
          {detail.tags?.map(t => (
            <span key={t} style={{ marginLeft: '0.5rem', background: 'var(--hover-bg)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{t}</span>
          ))}
        </div>

        {detail.summary && (
          <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: '1rem' }}>{detail.summary}</p>
        )}

        <div
          style={{ lineHeight: 1.8, fontSize: '1rem', overflowWrap: 'break-word', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: detail.contentHtml }}
        />

        <div style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--divider-color)' }}>
          <Link to={'/contributions/' + id + '/edit-request'} style={{ fontSize: '0.85rem', color: 'var(--accent-pink)' }}>
            提交修改申请
          </Link>
        </div>
      </article>
    </main>
  )
}