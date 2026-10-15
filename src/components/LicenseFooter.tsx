import { useTranslation } from 'react-i18next'
import { FlagStripe } from './FlagStripe'
import { BrandText } from './ui/BrandText'
import styles from './LicenseFooter.module.css'

/** 紧凑单行页脚，与 Pass 门户 LicenseFooter 同一版式。 */
export function LicenseFooter() {
  const { t } = useTranslation()
  const year = new Date().getFullYear()

  return (
    <footer className={styles.footer}>
      {/* 页脚顶部通栏旗帜条纹（§3.1）：全站默认的签名元素。
          当前页自带 page 作用域条纹（认证舞台）时自动让位（§1.5，见 App.module.css）。 */}
      <FlagStripe scope="footer" />
      <div className={styles.bar}>
        <p className={styles.license}>
          <span className={styles.heading}>{t('footer.heading')}</span>
          <span>{t('footer.text1')}</span>
          <span className={styles.sep} aria-hidden="true">
            ·
          </span>
          {/* 「将来会有单独版权页」的预告，不是授权条款本身：窄屏下要独占两三行，
              页脚会胖到与其分量不相称，因此只在宽屏显示。 */}
          <span className={styles.note}>{t('footer.text2')}</span>
        </p>
        <p className={styles.copyright}>
          <BrandText text={t('footer.copyright', { year })} />
        </p>
      </div>
    </footer>
  )
}
