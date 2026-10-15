import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminButton, Alert, Card, SectionLabel, Skeleton } from '@/components/admin'
import { Pagination } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import shell from '../Page.module.css'
import { DiffView } from './DiffView'
import {
  contentFormatLabel,
  fetchVersion,
  sameTags,
  VERSION_PAGE_SIZE,
  type VersionListState,
  type VersionSnapshot,
} from './versions'

const REASON_KEYS: Record<string, string> = {
  created: 'adminVersions.reasonCreated',
  author_edit: 'adminVersions.reasonAuthorEdit',
  edit_request_applied: 'adminVersions.reasonEditRequest',
}

/**
 * 侧栏的「版本历史」：每次内容变更（创建、作者修改、修改申请应用）各一条，倒序。
 * 第 1 页第一条就是当前内容；其余版本可以和当前内容逐项对照。
 */
export function VersionHistoryCard({
  versions,
  comparing,
  onCompare,
}: {
  versions: VersionListState & { load: (page: number) => Promise<void> }
  comparing: number | null
  onCompare: (version: number) => void
}) {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const latest = versions.page === 1 ? versions.items[0]?.version : undefined

  return (
    <Card tone="subtle" padding="sm">
      <SectionLabel>{t('adminVersions.title')}</SectionLabel>
      {versions.error && (
        <Alert tone="error">
          <span className={shell.errorRow}>
            {t('adminVersions.loadError')}
            <AdminButton
              variant="secondary"
              size="sm"
              onClick={() => void versions.load(versions.page)}
              disabled={versions.loading}
            >
              {t('common.retry')}
            </AdminButton>
          </span>
        </Alert>
      )}
      {versions.loading && versions.items.length === 0 ? (
        <Skeleton rows={3} />
      ) : versions.items.length === 0 ? (
        !versions.error && <p className={shell.subtleNote}>{t('adminVersions.empty')}</p>
      ) : (
        <>
          <ul className={shell.history}>
            {versions.items.map((v) => (
              <li key={v.id} className={shell.historyItem}>
                <span className={shell.historyHead}>
                  <strong>{t('common.versionShort', { version: v.version })}</strong>
                  <span>{t(REASON_KEYS[v.changeReason ?? ''] ?? 'adminVersions.reasonOther')}</span>
                </span>
                {v.changedBy?.displayName && (
                  <span>
                    {t('adminVersions.changedByPrefix')}
                    {v.changedBy.displayName}
                  </span>
                )}
                <span className={shell.historyTime}>{formatTs(v.createdAt)}</span>
                {v.version === latest ? (
                  <span className={shell.subtleNote}>{t('adminVersions.current')}</span>
                ) : (
                  <AdminButton
                    variant="ghost"
                    size="sm"
                    className={shell.versionCompareButton}
                    aria-pressed={comparing === v.version}
                    onClick={() => onCompare(v.version)}
                  >
                    {comparing === v.version ? t('adminVersions.comparing') : t('adminVersions.compare')}
                  </AdminButton>
                )}
              </li>
            ))}
          </ul>
          <Pagination
            page={versions.page}
            totalPages={versions.totalPages}
            total={versions.total}
            pageSize={VERSION_PAGE_SIZE}
            disabled={versions.loading}
            onChange={(p) => void versions.load(p)}
          />
        </>
      )}
    </Card>
  )
}

export interface CurrentContent {
  title: string
  summary: string | null
  contentRaw: string
  tags: string[]
  /** 正文格式与语言：只改了它们也是改动（格式决定正文怎么渲染） */
  contentFormat?: string | null
  language?: string | null
}

/**
 * 主栏的版本对照：选中的历史版本 → 当前内容，逐项列出有变化的标题、摘要、标签与正文（正文逐行）。
 */
export function VersionCompare({
  contributionId,
  version,
  current,
  onClose,
}: {
  contributionId: string
  version: number
  current: CurrentContent
  onClose: () => void
}) {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const [snapshot, setSnapshot] = useState<VersionSnapshot | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await fetchVersion(contributionId, version)
      if (cancelled) return
      if (result.ok) {
        setError('')
        setSnapshot(result.data)
      } else {
        setSnapshot(null)
        setError(result.error.message || t('adminVersions.loadError'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [contributionId, version, attempt, t])

  const sep = t('common.enumSeparator')
  const rows: Array<{ key: string; label: string; before: string; after: string }> = []
  if (snapshot) {
    if (snapshot.title !== current.title) {
      rows.push({
        key: 'title',
        label: t('adminContributions.titleLabel'),
        before: snapshot.title,
        after: current.title,
      })
    }
    if ((snapshot.summary ?? '') !== (current.summary ?? '')) {
      rows.push({
        key: 'summary',
        label: t('adminContributions.summary'),
        before: snapshot.summary ?? '',
        after: current.summary ?? '',
      })
    }
    if (!sameTags(snapshot.tags, current.tags)) {
      rows.push({
        key: 'tags',
        label: t('adminContributions.tags'),
        before: (snapshot.tags ?? []).join(sep),
        after: current.tags.join(sep),
      })
    }
    if (current.contentFormat && snapshot.contentFormat !== current.contentFormat) {
      rows.push({
        key: 'contentFormat',
        label: t('adminVersions.contentFormat'),
        before: contentFormatLabel(t, snapshot.contentFormat),
        after: contentFormatLabel(t, current.contentFormat),
      })
    }
    if (current.language && snapshot.language !== current.language) {
      rows.push({
        key: 'language',
        label: t('adminContributions.language'),
        before: t(`submit.languages.${snapshot.language}`, { defaultValue: snapshot.language }),
        after: t(`submit.languages.${current.language}`, { defaultValue: current.language }),
      })
    }
  }
  const contentChanged = !!snapshot && snapshot.contentRaw !== current.contentRaw

  return (
    <section className={shell.versionCompare} aria-labelledby="version-compare-heading">
      <div className={shell.versionCompareHead}>
        <h2 id="version-compare-heading" className={shell.sideHeading}>
          {t('adminVersions.compareTitle', { version })}
          {snapshot && (
            <span className={shell.subtleNote}>
              {' '}
              {t('adminVersions.compareMeta', {
                reason: t(REASON_KEYS[snapshot.changeReason ?? ''] ?? 'adminVersions.reasonOther'),
                time: formatTs(snapshot.createdAt),
              })}
            </span>
          )}
        </h2>
        <AdminButton variant="ghost" size="sm" onClick={onClose}>
          {t('adminVersions.close')}
        </AdminButton>
      </div>

      {error ? (
        <Alert tone="error">
          <span className={shell.errorRow}>
            {error}
            <AdminButton variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              {t('common.retry')}
            </AdminButton>
          </span>
        </Alert>
      ) : !snapshot ? (
        <Skeleton rows={3} />
      ) : rows.length === 0 && !contentChanged ? (
        <p className={shell.subtleNote}>{t('adminVersions.noDifference')}</p>
      ) : (
        <>
          {rows.map((row) => (
            <div key={row.key} className={shell.field}>
              <h3 className={shell.fieldLabel}>{row.label}</h3>
              <p className={shell.diffOld}>
                <span className={shell.diffTag}>{t('adminVersions.thenValue', { version })}</span>
                {row.before || t('adminEditRequests.emptyValue')}
              </p>
              <p className={shell.contentBlock}>
                <span className={shell.diffTag}>{t('adminVersions.nowValue')}</span>
                {row.after || t('adminEditRequests.emptyValue')}
              </p>
            </div>
          ))}
          {contentChanged && (
            <div className={shell.field}>
              <h3 className={shell.fieldLabel}>{t('adminContributions.source')}</h3>
              <DiffView
                before={snapshot.contentRaw}
                after={current.contentRaw}
                label={t('adminVersions.contentDiffLabel', { version })}
                beforeLabel={t('adminVersions.thenValue', { version })}
                afterLabel={t('adminVersions.nowValue')}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}
