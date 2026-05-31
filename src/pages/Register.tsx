import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import styles from '../App.module.css'

const Register = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { completeRegistration } = useAuth()

  const provider = searchParams.get('provider') || 'github'

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim()) {
      setError('请输入用户名')
      return
    }
    if (!password || password.length < 8) {
      setError('密码至少需要8个字符')
      return
    }

    setSubmitting(true)
    try {
      const result = await completeRegistration(provider, {
        username: username.trim(),
        email: email.trim() || undefined,
        displayName: displayName.trim() || undefined,
        password,
      })

      if (result?.user) {
        navigate(result.user.isAdmin ? '/admin' : '/submit', { replace: true })
      } else {
        setError('注册失败，请重试')
      }
    } catch {
      setError('注册失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>完成注册</h1>
        <p className={styles.subTitle}>
          你已通过 {provider === 'x' ? 'X (Twitter)' : 'GitHub'} 登录，请填写以下信息完成注册。
        </p>
      </header>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '420px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-main)' }}>用户名</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="你的用户名"
            required
            autoFocus
            style={{
              padding: '0.6rem 0.8rem',
              borderRadius: '8px',
              border: '1.5px solid var(--divider-color)',
              fontSize: '0.95rem',
              backgroundColor: 'var(--bg-color)',
              color: 'var(--text-main)',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-main)' }}>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少8个字符"
            required
            minLength={8}
            style={{
              padding: '0.6rem 0.8rem',
              borderRadius: '8px',
              border: '1.5px solid var(--divider-color)',
              fontSize: '0.95rem',
              backgroundColor: 'var(--bg-color)',
              color: 'var(--text-main)',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-main)' }}>邮箱 (选填)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            style={{
              padding: '0.6rem 0.8rem',
              borderRadius: '8px',
              border: '1.5px solid var(--divider-color)',
              fontSize: '0.95rem',
              backgroundColor: 'var(--bg-color)',
              color: 'var(--text-main)',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-main)' }}>显示名称 (选填)</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="你的显示名称"
            style={{
              padding: '0.6rem 0.8rem',
              borderRadius: '8px',
              border: '1.5px solid var(--divider-color)',
              fontSize: '0.95rem',
              backgroundColor: 'var(--bg-color)',
              color: 'var(--text-main)',
            }}
          />
        </label>

        {error && (
          <p style={{ color: 'var(--primary-pink)', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className={styles.ctaPrimary}
          style={{ border: 'none', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1, alignSelf: 'flex-start' }}
        >
          {submitting ? '注册中...' : '完成注册'}
        </button>
      </form>
    </>
  )
}

export default Register
