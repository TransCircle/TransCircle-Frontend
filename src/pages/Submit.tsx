import styles from '../App.module.css'

const Submit = () => {
  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>故事投稿</h1>
        <p className={styles.subTitle}>
          分享你的经历与故事。
        </p>
      </header>

      <section className={styles.introSection}>
        <p className={styles.greeting}>
          投稿系统正在开发中。
        </p>
      </section>
    </>
  )
}

export default Submit
