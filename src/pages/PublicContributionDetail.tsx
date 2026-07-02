import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import DOMPurify from 'dompurify'
import { AdminButton, Alert, Card, Pill, Spinner } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import shell from './Page.module.css'

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

export const PublicContributionDetail = () => {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const formatTs = useFormatTs()

  const [detail, setDetail] = useState<PublicDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = async () => {
      const result = await get<PublicDetail>(`/public/contributions/${id}`)
      if (cancelled) return
      if (result.ok) {
        setDetail(result.data)
      } else if (result.status === 404) {
        setError(t('publicContributionDetail.notFound'))
      } else {
        setError(result.error?.message || t('publicContributionDetail.notFound'))
      }
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [id, t])

  if (loading) {
    return (
      <div className={`${shell.page} ${shell.pageNarrow}`}>
        <Spinner size="lg" label={t('publicContributionDetail.loading')} />
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className={`${shell.page} ${shell.pageNarrow}`}>
        <Alert tone="error">{error || t('publicContributionDetail.notFound')}</Alert>
      </div>
    )
  }

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <div>
        <AdminButton variant="ghost" size="sm" onClick={() => navigate('/')}>
          {t('publicContributionDetail.backToHome')}
        </AdminButton>
      </div>

      <Card>
        <article className={shell.stack}>
          <div className={shell.stackSm}>
            <h1 className={shell.detailTitle}>{detail.title}</h1>
            <div className={shell.metaRow}>
              <span className={shell.metaItem}>
                {t('publicContributionDetail.author')}: {detail.author.displayName}
              </span>
              <span className={shell.metaItem}>{formatTs(detail.publishedAt)}</span>
              <span className={shell.metaItem}>{detail.language}</span>
              {detail.tags?.map((tag) => (
                <Pill key={tag}>{tag}</Pill>
              ))}
            </div>
          </div>

          {detail.summary && <p className={shell.subtleNote}>{detail.summary}</p>}

          <div className={shell.prose} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(detail.contentHtml) }} />

          <div className={shell.actions}>
            <AdminButton variant="ghost" size="sm" onClick={() => navigate(`/contributions/${id}/edit-request`)}>
              {t('publicContributionDetail.submitEditRequest')}
            </AdminButton>
          </div>
        </article>
      </Card>
    </div>
  )
}
