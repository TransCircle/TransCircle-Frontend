import { Fragment } from 'react'

import styles from './BrandText.module.css'

const BRAND_WORD = 'TransCircle'

export interface BrandTextProps {
  /** 已翻译好的整句文案；其中出现的品牌词会单独套品牌字体。 */
  text: string
}

/**
 * 把一句文案里的「TransCircle」换成品牌字体（DESIGN.md §2.6：Nunito Brand 仅用于品牌词）。
 * 文案整句仍由 i18n 提供，原样可用于 document.title 等纯文本场景；这里只在渲染时切分。
 */
export function BrandText({ text }: BrandTextProps) {
  const parts = text.split(BRAND_WORD)
  /* 外面包一层 span：放进 flex 容器（如 Alert）时整句是一个 flex 项；
     直接返回片段的话，每段文字和品牌词都会各自成为一个 flex 项，句子被拆成几列。 */
  return (
    <span>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={styles.brand}>{BRAND_WORD}</span>}
          {part}
        </Fragment>
      ))}
    </span>
  )
}
