import { genId } from './ulid'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Ed25519 密钥对（持久化到文件，支持多实例部署）
// 生产环境应从 KMS 加载
const KEY_DIR = process.env.JWT_KEY_DIR || join(process.cwd(), '.jwt-keys')
const PRIV_KEY_PATH = join(KEY_DIR, 'ed25519.priv.bin')
const PUB_KEY_PATH = join(KEY_DIR, 'ed25519.pub.bin')

let cachedPrivateKey: Uint8Array | null = null
let cachedPublicKey: Uint8Array | null = null

async function getKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  if (cachedPrivateKey && cachedPublicKey) {
    return { privateKey: cachedPrivateKey, publicKey: cachedPublicKey }
  }

  // Try loading from persistent file
  if (existsSync(PRIV_KEY_PATH) && existsSync(PUB_KEY_PATH)) {
    cachedPrivateKey = new Uint8Array(readFileSync(PRIV_KEY_PATH))
    cachedPublicKey = new Uint8Array(readFileSync(PUB_KEY_PATH))
    return { privateKey: cachedPrivateKey, publicKey: cachedPublicKey }
  }

  // Generate and persist
  const ed = await import('@noble/ed25519')
  const key = await ed.keygenAsync()

  // Ensure directory exists
  if (!existsSync(KEY_DIR)) {
    mkdirSync(KEY_DIR, { recursive: true })
  }

  writeFileSync(PRIV_KEY_PATH, Buffer.from(key.secretKey))
  writeFileSync(PUB_KEY_PATH, Buffer.from(key.publicKey))

  cachedPrivateKey = key.secretKey
  cachedPublicKey = key.publicKey
  return { privateKey: key.secretKey, publicKey: key.publicKey }
}

export interface JwtPayload {
  iss: string
  aud: string
  sub: string
  jti: string
  sid: string
  roles: string[]
  tokenVersion: number
  iat: number
  exp: number
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function decodeBase64url(s: string): Uint8Array {
  let str = s.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
}

/** Sign a JWT with Ed25519. Returns the full JWT string. */
export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>,
): Promise<string> {
  const ed = await import('@noble/ed25519')
  const { privateKey } = await getKeyPair()
  const now = Math.floor(Date.now() / 1000)

  const jwtPayload: JwtPayload = {
    ...payload,
    jti: genId('jwt_'),
    iat: now,
    exp: now + 900, // 15 min
  }

  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' })),
  )
  const body = base64url(
    new TextEncoder().encode(JSON.stringify(jwtPayload)),
  )
  const message = `${header}.${body}`
  const signature = await ed.signAsync(new TextEncoder().encode(message), privateKey)
  return `${message}.${base64url(signature)}`
}

/** Verify and decode a JWT. Returns null if invalid/expired. */
export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const ed = await import('@noble/ed25519')
    const { publicKey } = await getKeyPair()
    const valid = await ed.verifyAsync(
      decodeBase64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      publicKey,
    )
    if (!valid) return null

    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64url(parts[1])),
    ) as JwtPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
