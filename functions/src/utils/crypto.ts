/**
 * KMS-like envelope encryption for sensitive data.
 * Uses AES-256-GCM with a key derived from SESSION_SECRET via PBKDF2.
 *
 * 生产环境升级路径（按优先级）:
 *   1. 设置 AWS KMS / GCP Cloud KMS — 在 Config 中配置 KMS_KEY_ID / KMS_REGION，
 *      用 KMS GenerateDataKey 派生每次加密的 data key，主 key 由云平台托管
 *   2. 设置 HASHI_Vault  Transit 引擎 — 在 Config 中配置 VAULT_TRANSIT_KEY_PATH，
 *      所有加密/解密操作委托给 Vault，支持 key rotation 和 audit
 *   3. 维持当前 PBKDF2 + AES-256-GCM 方案，但将 SESSION_SECRET 替换为
 *      由 KMS 托管的加密密钥文件（JWT_KEY_DIR/encryption-key.bin）
 *
 * api.md 安全基线: "TOTP secret、Passkey 公钥等均以 hmac_sha256 或 KMS 加密后入库"
 */

import { conf } from '../Config'

const SESSION_SECRET =
  ((conf.SESSION as Record<string, string | undefined>)?.SESS_SECRET) || 'default-secret-change-me'

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const secretBytes = new Uint8Array(enc.encode(SESSION_SECRET))
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt plaintext → base64url( salt || iv || ciphertext ) */
export async function encryptSecret(plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(salt)
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    enc.encode(plaintext),
  )
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length)

  return btoa(String.fromCharCode(...combined))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Decrypt base64url( salt || iv || ciphertext ) → plaintext */
export async function decryptSecret(encoded: string): Promise<string> {
  // Convert base64url → base64
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  const salt = raw.slice(0, 16)
  const iv = raw.slice(16, 28)
  const ciphertext = raw.slice(28)
  const key = await deriveKey(salt)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer)
  return new TextDecoder().decode(decrypted)
}

/**
 * Encrypt OAuth PII fields into a single encrypted JSON blob (api.md §1.6.2).
 * Stores providerEmail, providerDisplayName, providerUsername, providerAvatarUrl securely.
 */
export interface OAuthPii {
  providerEmail?: string | null
  providerDisplayName?: string | null
  providerUsername?: string | null
  providerAvatarUrl?: string | null
  providerEmailVerified?: boolean
  csrfToken?: string
}

export async function encryptOAuthPii(pii: OAuthPii): Promise<string> {
  return encryptSecret(JSON.stringify(pii))
}

export async function decryptOAuthPii(encrypted: string): Promise<OAuthPii> {
  const json = await decryptSecret(encrypted)
  return JSON.parse(json) as OAuthPii
}
