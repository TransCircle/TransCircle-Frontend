import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { post, setAccessToken } from '@/api/client'

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
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [challengeId, setChallengeId] = useState('')
  const [availableMethods, setAvailableMethods] = useState<StepUpMethod[]>([])
  const [passkeyChallenge, setPasskeyChallenge] = useState<StartResponse['passkey'] | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<StepUpMethod | null>(null)

  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  /** Tracks whether handlePasskey has been triggered (for render — ref is used for the actual guard) */
  const [passkeyProcessing, setPasskeyProcessing] = useState(false)

  const passkeyProcessed = useRef(false)

  // Sync accessToken into client memory so step-up API calls use correct auth
  useEffect(() => {
    if (accessToken) setAccessToken(accessToken)
  }, [accessToken])

  // Focus trap: trap focus inside dialog when open
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    first?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return }
      if (e.key !== 'Tab') return
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [onCancel])

  // Fetch available methods on mount
  useEffect(() => {
    const init = async () => {
      const result = await post<StartResponse>(
        '/auth/step-up/start',
        {},
      )
      if (!result.ok || !result.data.challengeId) {
        setError(t('stepUp.errorInit'))
        return
      }
      setChallengeId(result.data.challengeId)
      const methods = result.data.availableMethods || []
      setAvailableMethods(methods)
      setPasskeyChallenge(result.data.passkey ?? null)

      // Default to password, fallback to first available
      setSelectedMethod(methods.includes('password') ? 'password' : (methods[0] ?? null))
    }
    init()
  }, [accessToken, t])

  const handleSubmit = async () => {
    if (!challengeId || !selectedMethod) return
    setSubmitting(true)
    setError('')

    try {
      const body: Record<string, unknown> = { challengeId, method: selectedMethod }

      if (selectedMethod === 'password') {
        if (!password) {
          setError(t('stepUp.errorPasswordEmpty'))
          setSubmitting(false)
          return
        }
        body.password = password
      } else if (selectedMethod === 'totp' || selectedMethod === 'recovery_code') {
        if (!code) {
          setError(t('stepUp.errorCodeEmpty'))
          setSubmitting(false)
          return
        }
        body.code = code
      } else if (selectedMethod === 'passkey') {
        setSubmitting(false)
        return
      }

      const result = await post('/auth/step-up/verify', body)

      if (!result.ok) {
        throw new Error(result.error.message || t('stepUp.errorFailed'))
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('stepUp.errorFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasskey = async () => {
    if (!challengeId || !passkeyChallenge || passkeyProcessed.current) return
    passkeyProcessed.current = true
    setPasskeyProcessing(true)
    setSubmitting(true)
    setError('')

    try {
      // Convert base64url challenge to ArrayBuffer for WebAuthn API
      const allowCreds: PublicKeyCredentialDescriptor[] | undefined =
        passkeyChallenge.publicKey.allowCredentials?.map((c: { id: string; type: 'public-key'; transports: string[] }) => ({
          type: 'public-key' as const,
          id: Uint8Array.from(
            atob(c.id.replace(/-/g, '+').replace(/_/g, '/')),
            (cc: string) => cc.charCodeAt(0),
          ).buffer as ArrayBuffer,
          transports: c.transports as AuthenticatorTransport[],
        }))
      const publicKeyCredOpts: PublicKeyCredentialRequestOptions = {
        challenge: Uint8Array.from(
          atob(passkeyChallenge.publicKey.challenge.replace(/-/g, '+').replace(/_/g, '/')),
          (c: string) => c.charCodeAt(0),
        ).buffer as ArrayBuffer,
        rpId: passkeyChallenge.publicKey.rpId,
        userVerification: passkeyChallenge.publicKey.userVerification as UserVerificationRequirement,
        allowCredentials: allowCreds,
      }
      const credential = await navigator.credentials.get({ publicKey: publicKeyCredOpts })

      if (!credential) {
        setError(t('stepUp.errorUserCancel'))
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
          clientExtensionResults: pkCred.getClientExtensionResults(),
        },
      })

      if (!result.ok) {
        throw new Error(result.error.message || t('stepUp.errorPasskeyFailed'))
      }

      onSuccess()
    } catch (err) {
      passkeyProcessed.current = false  // Allow retry on cancel/error
      setPasskeyProcessing(false)
      setError(err instanceof Error ? err.message : t('stepUp.errorPasskeyFailed'))
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

  // Reset passkey guard when method switches away from passkey (M7)
  useEffect(() => {
    if (selectedMethod !== 'passkey') {
      passkeyProcessed.current = false
    }
  }, [selectedMethod])

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
    password: t('stepUp.methodPassword'),
    passkey: t('stepUp.methodPasskey'),
    totp: t('stepUp.methodTotp'),
    recovery_code: t('stepUp.methodRecoveryCode'),
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      style={{
        position: 'fixed', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--overlay-bg)', zIndex: 1000,
      }}
    >
      <div style={{
        background: 'var(--bg-color)',
        padding: '2rem', borderRadius: 'var(--radius-lg)',
        maxWidth: '400px', width: '90%',
      }}>
        <h3 style={{ margin: '0 0 0.5rem' }} id="stepup-title">{t('stepUp.title')}</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {t('stepUp.description')}
        </p>

        {/* Method selector */}
        {availableMethods.length > 1 && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem' }}>
              {t('stepUp.methodLabel')}
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
            placeholder={t('stepUp.passwordPlaceholder')}
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
            placeholder={selectedMethod === 'totp' ? t('stepUp.totpPlaceholder') : t('stepUp.recoveryCodePlaceholder')}
            maxLength={selectedMethod === 'totp' ? 6 : undefined}
            style={{ width: '100%', padding: '0.5rem', marginBottom: '0.75rem' }}
            autoFocus
          />
        )}

        {selectedMethod === 'passkey' && (
          <div>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {passkeyProcessing ? t('stepUp.passkeyPrompting') : t('stepUp.passkeyPrompt')}
            </p>
            {!passkeyProcessing && (
              <button
                onClick={() => {
                  passkeyProcessed.current = true
                  setPasskeyProcessing(true)
                  handlePasskey()
                }}
                disabled={submitting}
                style={{ padding: '0.4rem 1rem', background: 'var(--accent-pink)', color: 'var(--surface-card)', border: 'none', borderRadius: '50px', cursor: 'pointer', fontFamily: 'inherit', width: '100%' }}
              >
                {submitting ? t('stepUp.verifying') : t('stepUp.passkeyStart')}
              </button>
            )}
          </div>
        )}

        {error && <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={submitting} style={{ padding: '0.4rem 1rem' }}>{t('stepUp.cancel')}</button>
          {selectedMethod !== 'passkey' && (
            <button onClick={handleSubmit} disabled={submitting || !selectedMethod} style={{
              padding: '0.4rem 1rem', background: 'var(--accent-pink, #e91e63)', color: 'var(--surface-card)', border: 'none',
            }}>
              {submitting ? t('stepUp.verifying') : t('stepUp.confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
