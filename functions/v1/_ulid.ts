// Crockford Base32 ULID generator
// Format: 26 chars, timestamp (10) + random (16)
// Alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ (excludes I,L,O,U)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ts: number): string {
  let str = ''
  for (let i = 9; i >= 0; i--) {
    str = CROCKFORD[ts & 0x1f] + str
    ts >>>= 5
  }
  return str
}

function encodeRandom(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let str = ''
  for (let i = 0; i < len; i++) {
    str += CROCKFORD[bytes[i] & 0x1f]
  }
  return str
}

export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom(16)
}

export function ulidWithPrefix(prefix: string): string {
  return `${prefix}${ulid()}`
}

export function requestId(): string {
  return `req_${ulid()}`
}
