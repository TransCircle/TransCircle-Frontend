import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { sanitizeHtml } from '@/utils/sanitize'
import { AdminButton, Alert, Skeleton } from '@/components/ui'
import { CommentSection } from '@/components/CommentSection'
import { useFormatTs } from '@/utils/datetime'
import styles from './Story.module.css'

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

/** 头像回退：取显示名首字，无名时用间隔号占位（不留空圆）。 */
const initialOf = (name: string) => (name ?? '').trim().charAt(0) || '·'

const BackIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m15 18-6-6 6-6" />
  </svg>
)

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
    /* 换文章（前进/后退在同一路由的两个 :id 之间跳）时必须先把上一篇的
       结果清干净：留着 detail 会让新文章加载期间显示旧正文；留着 error
       更糟——上一篇若是 404，新文章即使加载成功，错误分支仍然优先，
       页面会一直停在「未找到」。 */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null)
    setError('')
    setLoading(true)
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
    // 保留页面框架（返回按钮 + 容器），仅内容区骨架占位，避免整页替换为 Spinner 的布局跳变
    return (
      <div className={styles.reading}>
        <div className={styles.topBar}>
          <AdminButton variant="ghost" size="sm" iconLeft={<BackIcon />} disabled>
            {t('publicContributionDetail.backToHome')}
          </AdminButton>
        </div>
        <Skeleton variant="article" />
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className={styles.reading}>
        <Alert tone="error">{error || t('publicContributionDetail.notFound')}</Alert>
      </div>
    )
  }

  return (
    <div className={styles.reading}>
      {/* 顶部动作条：左侧返回（导航），右侧修改申请（本页唯一的次要动作）。
          放在正文之上而不是文末——读完再滚回顶部找入口是反直觉的。 */}
      <div className={styles.topBar}>
        <AdminButton variant="ghost" size="sm" iconLeft={<BackIcon />} onClick={() => navigate('/')}>
          {t('publicContributionDetail.backToHome')}
        </AdminButton>
        <AdminButton
          variant="secondary"
          size="sm"
          className={styles.topAction}
          onClick={() => navigate(`/contributions/${id}/edit-request`)}
        >
          {t('publicContributionDetail.submitEditRequest')}
        </AdminButton>
      </div>

      <article className={styles.article}>
        <h1 className={styles.articleTitle}>{detail.title}</h1>

        {/* 摘要紧跟标题，作为导语独立成段——排在作者区之前，靠下方的发丝线
            与正文彻底隔开，不会被读成正文的第一段。 */}
        {detail.summary && <p className={styles.dek}>{detail.summary}</p>}

        {/* 作者身份区：上下发丝线夹出，是全站最重的一次「人」的在场。
            视觉上不再写「作者:」前缀（头像 + 署名已表明身份），
            语义仍通过 aria-label 提供给辅助技术。 */}
        <div className={styles.authorBlock} aria-label={t('publicContributionDetail.author')}>
          {detail.author.avatarUrl ? (
            <img className={styles.authorAvatar} src={detail.author.avatarUrl} alt="" />
          ) : (
            <span className={styles.authorAvatarFallback} aria-hidden="true">
              {initialOf(detail.author.displayName)}
            </span>
          )}
          <span className={styles.authorText}>
            <span className={styles.authorName}>{detail.author.displayName}</span>
            <span className={styles.articleMeta}>
              <span>{formatTs(detail.publishedAt)}</span>
              <span aria-hidden="true">·</span>
              <span>{t('submit.languages.' + detail.language, { defaultValue: detail.language })}</span>
            </span>
          </span>
          {detail.tags?.length > 0 && (
            <span className={styles.articleTags}>
              {detail.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
        </div>

        <div className={styles.prose} dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.contentHtml) }} />
      </article>

      {/* key：切换投稿时整体重挂载评论区，避免上一篇的在途提交/删除回调
          改写这一篇的评论列表（两者共用同一个分页 hook 实例时会互相干扰）。 */}
      {id && <CommentSection key={id} contributionId={id} />}
    </div>
  )
}
