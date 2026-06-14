/**
 * Minimal TOTP (RFC 6238) implementation using Web Crypto API.
 * Supports verification with replay prevention via lastUsedTimeStep.
 */

const TOTP_PERIOD = 30
const TOTP_DIGITS = 6

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/=+$/, '').toUpperCase()
  const bytes: number[] = []
  let buffer = 0
  let bitsLeft = 0
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid Base32 character: ${ch}`)
    buffer = (buffer << 5) | idx
    bitsLeft += 5
    if (bitsLeft >= 8) {
      bitsLeft -= 8
      bytes.push((buffer >> bitsLeft) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

async function hmacSha1(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource)
  return new Uint8Array(sig)
}

function truncate(hmacResult: Uint8Array): number {
  const offset = hmacResult[hmacResult.length - 1]! & 0xf
  const code =
    ((hmacResult[offset]! & 0x7f) << 24) |
    ((hmacResult[offset + 1]! & 0xff) << 16) |
    ((hmacResult[offset + 2]! & 0xff) << 8) |
    (hmacResult[offset + 3]! & 0xff)
  return code % Math.pow(10, TOTP_DIGITS)
}

export function getCurrentTimeStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD)
}

export async function generateTotpCode(secret: string, timeStep?: number): Promise<string> {
  let ts = timeStep ?? getCurrentTimeStep()
  const key = base32Decode(secret)

  // Big-endian 8-byte counter
  const counter = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    counter[i] = ts & 0xff
    ts >>>= 8
  }

  const hmac = await hmacSha1(key, counter)
  const code = truncate(hmac)
  return String(code).padStart(TOTP_DIGITS, '0')
}

/**
 * Verify a TOTP code with ±1 time-step window and replay prevention.
 * Returns the candidateTimeStep on success, or null on failure.
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  lastUsedTimeStep: number | null,
): Promise<number | null> {
  const currentTs = getCurrentTimeStep()

  // Check current, current-1, current+1
  for (const candidate of [currentTs, currentTs - 1, currentTs + 1]) {
    if (lastUsedTimeStep !== null && candidate <= lastUsedTimeStep) continue

    const expected = await generateTotpCode(secret, candidate)
    if (expected === code) return candidate
  }

  return null
}
