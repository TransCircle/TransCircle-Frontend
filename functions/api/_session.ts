// Encrypted session cookie management using Web Crypto API
// No external dependencies — works entirely within Workers runtime

interface SessionData {
  provider: 'github' | 'x'
  userId: string
  username: string
  avatarUrl?: string
  isAdmin: boolean
  exp: number // unix timestamp
}

const COOKIE_NAME = 'tc_session'
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

function b64ToUint8(b64: string): Uint8Array {
  // Decode URL-safe base64
  const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  return new Uint8Array([...str].map((c) => c.charCodeAt(0)))
}

function uint8ToB64(buf: Uint8Array): string {
  const str = String.fromCharCode(...buf)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function getKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyData = enc.encode(secret).slice(0, 32) // Use first 32 bytes
  return crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encrypt(secret: string, data: string): Promise<string> {
  const key = await getKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(data))
  // iv + ciphertext
  const combined = new Uint8Array(iv.length + new Uint8Array(buf).length)
  combined.set(iv)
  combined.set(new Uint8Array(buf), iv.length)
  return uint8ToB64(combined)
}

async function decrypt(secret: string, token: string): Promise<string | null> {
  try {
    const key = await getKey(secret)
    const data = b64ToUint8(token)
    const iv = data.slice(0, 12)
    const ct = data.slice(12)
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new TextDecoder().decode(buf)
  } catch {
    return null
  }
}

export function createSessionCookie(
  secret: string,
  session: SessionData,
): string {
  const payload = JSON.stringify(session)
  // We need to first encrypt, but that's async. We'll use a sync barrier via a response header approach.
  // Actually for Cookie creation, we must return the encrypted value synchronously.
  // We'll set the cookie in the handler after encryption.
  return payload // placeholder, real encryption happens in setSessionCookie
}

export async function setSessionCookie(
  response: Response,
  secret: string,
  session: SessionData,
): Promise<Response> {
  const payload = JSON.stringify(session)
  const encrypted = await encrypt(secret, payload)
  const headers = new Headers(response.headers)
  headers.set(
    'Set-Cookie',
    `${COOKIE_NAME}=${encrypted}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
  )
  return new Response(response.body, { ...response, headers })
}

export async function getSession(
  request: Request,
  secret: string,
): Promise<SessionData | null> {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  if (!match) return null

  const decrypted = await decrypt(secret, match[1])
  if (!decrypted) return null

  try {
    const session = JSON.parse(decrypted) as SessionData
    if (Date.now() > session.exp * 1000) return null
    return session
  } catch {
    return null
  }
}

export function clearSessionCookie(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  )
  return new Response(response.body, { ...response, headers })
}
