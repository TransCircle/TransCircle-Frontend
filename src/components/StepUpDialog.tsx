import { useState } from 'react'
import { API_BASE } from '@/config'

interface StepUpDialogProps {
  onSuccess: () => void
  onCancel: () => void
}

export const StepUpDialog = ({ onSuccess, onCancel }: StepUpDialogProps) => {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleStepUp = async () => {
    setSubmitting(true)
    setError('')

    try {
      // 1. Start step-up challenge
      const startRes = await fetch(`${API_BASE}/auth/step-up/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!startRes.ok) throw new Error('无法发起验证')
      const startBody = await startRes.json() as { data?: { challengeId: string } }
      const challengeId = startBody.data?.challengeId
      if (!challengeId) throw new Error('验证失败')

      // 2. Verify with password
      const verifyRes = await fetch(`${API_BASE}/auth/step-up/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challengeId, method: 'password', password }),
      })
      if (!verifyRes.ok) {
        const errBody = await verifyRes.json() as { error?: { code?: string; message?: string } }
        throw new Error(errBody.error?.message || '验证失败')
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)', zIndex: 1000,
    }}>
      <div style={{
        background: 'var(--bg-color, #fff)',
        padding: '2rem', borderRadius: '10px',
        maxWidth: '400px', width: '90%',
      }}>
        <h3 style={{ margin: '0 0 1rem' }}>二次验证</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          此操作需要输入密码以确认身份
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="输入当前密码"
          style={{ width: '100%', padding: '0.5rem', marginBottom: '0.75rem' }}
          autoFocus
        />
        {error && <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={submitting} style={{ padding: '0.4rem 1rem' }}>取消</button>
          <button onClick={handleStepUp} disabled={submitting || !password} style={{
            padding: '0.4rem 1rem', background: 'var(--accent-pink, #e91e63)', color: '#fff', border: 'none',
          }}>
            {submitting ? '验证中...' : '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
