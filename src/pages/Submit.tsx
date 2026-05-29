import SubmitForm from '@/components/SubmitForm'
import styles from '../App.module.css'

const Submit = () => {
  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>故事投稿</h1>
        <p className={styles.subTitle}>
          分享你的经历与故事。所有投稿经审核后发布在 story.transcircle.org。
        </p>
      </header>

      <SubmitForm />
    </>
  )
}

export default Submit
