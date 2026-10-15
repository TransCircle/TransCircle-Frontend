import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { collapseDiff, diffLines } from '@/utils/lineDiff'
import shell from '../Page.module.css'

/**
 * 按行对照两段文本：删除的行在前（删除线 + 错误色），新增的行在后（成功色），
 * 未改动的长段折叠成「未改动 N 行」。行太多算不动时退回「当前 / 改为」两块整段对照。
 *
 * 颜色之外还有两层信号：行首 −/+ 标记，以及 <del>/<ins> 语义加读屏前缀——不只靠颜色区分。
 */
export function DiffView({
  before,
  after,
  label,
  beforeLabel,
  afterLabel,
}: {
  before: string
  after: string
  label: string
  /** 整段对照（行太多时）两块的标签：缺省「当前 / 改为」（修改申请）；版本对照传「vN / 现在」 */
  beforeLabel?: string
  afterLabel?: string
}) {
  const { t } = useTranslation()
  const lines = useMemo(() => diffLines(before, after), [before, after])

  if (!lines) {
    return (
      <div className={shell.stackSm}>
        <p className={shell.subtleNote}>{t('diff.tooLarge')}</p>
        <span className={shell.diffTag}>{beforeLabel ?? t('adminEditRequests.currentValue')}</span>
        <pre
          className={`${shell.rawSource} ${shell.rawSourceOld}`}
          tabIndex={0}
          aria-label={t('diff.beforeLabel', { label })}
        >
          {before}
        </pre>
        <span className={shell.diffTag}>{afterLabel ?? t('adminEditRequests.nextValue')}</span>
        <pre className={shell.rawSource} tabIndex={0} aria-label={t('diff.afterLabel', { label })}>
          {after}
        </pre>
      </div>
    )
  }

  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  const chunks = collapseDiff(lines)

  return (
    <div className={shell.diff}>
      <p className={shell.diffStats}>{t('diff.stats', { added, removed })}</p>
      <div className={shell.diffBody} tabIndex={0} role="region" aria-label={label}>
        {chunks.map((chunk, ci) =>
          chunk.kind === 'gap' ? (
            <div key={`gap-${ci}`} className={shell.diffGap}>
              {t('diff.unchanged', { count: chunk.count })}
            </div>
          ) : (
            chunk.lines.map((line, li) => {
              const key = `${ci}-${li}`
              const text = line.text === '' ? ' ' : line.text
              if (line.kind === 'add') {
                return (
                  <ins key={key} className={`${shell.diffLine} ${shell.diffAdd}`}>
                    <span className={shell.diffMark} aria-hidden="true">
                      +
                    </span>
                    <span className={shell.srOnly}>{t('diff.addedPrefix')}</span>
                    {text}
                  </ins>
                )
              }
              if (line.kind === 'del') {
                return (
                  <del key={key} className={`${shell.diffLine} ${shell.diffDel}`}>
                    <span className={shell.diffMark} aria-hidden="true">
                      −
                    </span>
                    <span className={shell.srOnly}>{t('diff.removedPrefix')}</span>
                    {text}
                  </del>
                )
              }
              return (
                <div key={key} className={shell.diffLine}>
                  <span className={shell.diffMark} aria-hidden="true">
                    {' '}
                  </span>
                  {text}
                </div>
              )
            })
          ),
        )}
      </div>
    </div>
  )
}
