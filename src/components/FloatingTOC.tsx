import { useTranslation } from 'react-i18next'
import styles from './FloatingTOC.module.css'

export interface TOCItem {
  href: string
  label: string
}

interface FloatingTOCProps {
  items: TOCItem[]
  label?: string
}

export const FloatingTOC = ({ items, label }: FloatingTOCProps) => {
  const { t } = useTranslation()
  const ariaLabel = label || t('toc.label')

  return (
    <nav className={styles.toc} aria-label={ariaLabel}>
      <span className={styles.heading} aria-hidden="true">
        {ariaLabel}
      </span>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href} className={styles.link}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
