import { useState, useEffect, useRef } from 'react'
import { post } from '@/api/client'

interface StepUpDialogProps {
  onSuccess: () => void
  onCancel: () => void
  /** 用于 API 认证的 Bearer Token — api.md §1.12 要求 */
  accessToken: string
}

type StepUpMethod = 'password' | 'passkey' | 'totp' | 'recovery_code'

interface StartResponse {
  challengeId: string
  expiresIn: number
  availableMethods: StepUpMethod[]
  passkey?: {
    publicKey: {
      challenge: string
      rpId: string
      userVerification: string
      allowCredentials: Array<{
        id: string
        type: 'public-key'
        transports: string[]
      }>
    }
  }
}

export const StepUpDialog = ({ onSuccess, onCancel, accessToken }: StepUpDialogProps) => {
  const [challengeId, setChallengeId] = useState('')
  const [availableMethods, setAvailableMethods] = useState<StepUpMethod[]>([])
  const [passkeyChallenge, setPasskeyChallenge] = useState<StartResponse['passkey']['publicKey'] | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<StepUpMethod | null>(null)

  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const passkeyProcessed = useRef(false)

  // Fetch available methods on mount
  useEffect(() => {
    const init = async () => {
      const result = await post<StartResponse>(
        '/auth/step-up/start',
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!result.ok || !result.data.challengeId) {
        setError('无法发起验证')
        return
      }
      setChallengeId(result.data.challengeId)
      const methods = result.data.availableMethods || []
      setAvailableMethods(methods)
      setPasskeyChallenge(result.data.passkey?.publicKey ?? null)

      // Default to password, fallback to first available
      setSelectedMethod(methods.includes('password') ? 'password' : (methods[0] ?? null))
    }
    init()
  }, [accessToken])

  const handleSubmit = async () => {
    if (!challengeId || !selectedMethod) return
    setSubmitting(true)
    setError('')

    try {
      const body: Record<string, unknown> = { challengeId, method: selectedMethod }

      if (selectedMethod === 'password') {
        if (!password) {
          setError('请输入密码')
          setSubmitting(false)
          return
        }
        body.password = password
      } else if (selectedMethod === 'totp' || selectedMethod === 'recovery_code') {
        if (!code) {
          setError('请输入验证码')
          setSubmitting(false)
          return
        }
        body.code = code
      } else if (selectedMethod === 'passkey') {
        // passkey flow handled separately in handlePasskey
        setSubmitting(false)
        return
      }

      const result = await post('/auth/step-up/verify', body, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!result.ok) {
        throw new Error(result.error.message || '验证失败')
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasskey = async () => {
    if (!challengeId || !passkeyChallenge || passkeyProcessed.current) return
    passkeyProcessed.current = true
    setSubmitting(true)
    setError('')

    try {
      // Convert base64url challenge to ArrayBuffer for WebAuthn API
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: Uint8Array.from(
            atob(passkeyChallenge.challenge.replace(/-/g, '+').replace(/_/g, '/')),
            c => c.charCodeAt(0),
          ).buffer as ArrayBuffer,
          rpId: passkeyChallenge.rpId,
          userVerification: passkeyChallenge.userVerification as UserVerificationRequirement,
          allowCredentials: passkeyChallenge.allowCredentials?.map(c => ({
            ...c,
            id: Uint8Array.from(
              atob(c.id.replace(/-/g, '+').replace(/_/g, '/')),
              cc => cc.charCodeAt(0),
            ),
          })),
        } as CredentialRequestOptions,
      })

      if (!credential) {
        setError('用户取消了操作')
        setSubmitting(false)
        return
      }

      const pkCred = credential as PublicKeyCredential
      const response = pkCred.response as AuthenticatorAssertionResponse

      const result = await post('/auth/step-up/verify', {
        challengeId,
        method: 'passkey',
        passkeyAssertion: {
          id: pkCred.id,
          rawId: pkCred.id,
          type: pkCred.type,
          response: {
            clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
            authenticatorData: arrayBufferToBase64url(response.authenticatorData),
            signature: arrayBufferToBase64url(response.signature),
            userHandle: response.userHandle ? arrayBufferToBase64url(response.userHandle) : null,
          },
          clientExtensionResults: pkCred.clientExtensionResults || {},
        },
      }, { headers: { Authorization: `Bearer ${accessToken}` } })

      if (!result.ok) {
        throw new Error(result.error.message || 'Passkey 验证失败')
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败')
    } finally {
      setSubmitting(false)
    }
  }

  function arrayBufferToBase64url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  // Auto-trigger passkey flow when selected
  useEffect(() => {
    if (selectedMethod === 'passkey' && challengeId && passkeyChallenge) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      handlePasskey()
    }
    // Only run when selectedMethod changes to passkey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMethod, challengeId, passkeyChallenge])

  const methodLabels: Record<StepUpMethod, string> = {
    password: '密码',
    passkey: 'Passkey（生物识别 / PIN）',
    totp: 'TOTP 验证码',
    recovery_code: '恢复码',
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
        <h3 style={{ margin: '0 0 0.5rem' }}>二次验证</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          此操作需要验证身份
        </p>

        {/* Method selector */}
        {availableMethods.length > 1 && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem' }}>
              验证方式
            </label>
            <select
              value={selectedMethod ?? ''}
              onChange={e => setSelectedMethod(e.target.value as StepUpMethod)}
              style={{ width: '100%', padding: '0.4rem', fontSize: '0.9rem' }}
            >
              {availableMethods.map(m => (
                <option key={m} value={m}>{methodLabels[m]}</option>
              ))}
            </select>
          </div>
        )}

        {selectedMethod === 'password' && (
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="输入当前密码"
            style={{ width: '100%', padding: '0.5rem', marginBottom: '0.75rem' }}
            autoFocus
          />
        )}

        {(selectedMethod === 'totp' || selectedMethod === 'recovery_code') && (
          <input
            type="text"
            inputMode={selectedMethod === 'totp' ? 'numeric' : 'text'}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder={selectedMethod === 'totp' ? '输入 6 位验证码' : '输入恢复码'}
            maxLength={selectedMethod === 'totp' ? 6 : undefined}
            style={{ width: '100%', padding: '0.5rem', marginBottom: '0.75rem' }}
            autoFocus
          />
        )}

        {selectedMethod === 'passkey' && (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
            正在请求 Passkey 验证...
          </p>
        )}

        {error && <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={submitting} style={{ padding: '0.4rem 1rem' }}>取消</button>
          {selectedMethod !== 'passkey' && (
            <button onClick={handleSubmit} disabled={submitting || !selectedMethod} style={{
              padding: '0.4rem 1rem', background: 'var(--accent-pink, #e91e63)', color: '#fff', border: 'none',
            }}>
              {submitting ? '验证中...' : '确认'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
