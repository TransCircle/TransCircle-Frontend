// JWT sign/verify using Web Crypto API (HMAC-SHA256)
// Matches apidocs.md §1.3 auth model

import { ulidWithPrefix } from './_ulid'

interface JwtPayload {
  sub: string       // userId
  sid: string       // sessionId
  jti: string       // token unique id
  tokenVersion: number
  roles: string[]
  provider: string
  username: string
  iat: number       // seconds
  exp: number       // seconds
}

const ACCESS_TOKEN_TTL = 15 * 60 // 15 minutes in seconds

function b64UrlEncode(buf: Uint8Array): string {
  const str = String.fromCharCode(...buf)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64UrlDecode(b64: string): Uint8Array {
  const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  return new Uint8Array([...str].map((c) => c.charCodeAt(0)))
}

const encoder = new TextEncoder()

async function signPayload(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = b64UrlEncode(encoder.encode(JSON.stringify(header)))
  const payloadB64 = b64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
  const sigB64 = b64UrlEncode(new Uint8Array(sig))

  return `${signingInput}.${sigB64}`
}

async function verifyToken(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, sigB64] = parts
    const signingInput = `${headerB64}.${payloadB64}`

    const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sig = b64UrlDecode(sigB64)
    const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(signingInput))
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(payloadB64))) as JwtPayload

    // Check expiration
    if (Date.now() / 1000 > payload.exp) return null

    return payload
  } catch {
    return null
  }
}

export function createAccessToken(
  secret: string,
  user: { userId: string; username: string; provider: string; isAdmin: boolean },
  tokenVersion: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = {
    sub: user.userId,
    sid: ulidWithPrefix('sess_'),
    jti: ulidWithPrefix('jti_'),
    tokenVersion,
    roles: user.isAdmin ? ['admin'] : ['user'],
    provider: user.provider,
    username: user.username,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL,
  }
  return signPayload(payload, secret)
}

export function verifyAccessToken(token: string, secret: string): Promise<JwtPayload | null> {
  return verifyToken(token, secret)
}

export { type JwtPayload }
