import argon2 from 'argon2'

/**
 * Hash a password using argon2id per api.md 安全基线:
 * - type: argon2id
 * - memoryCost: 64 MiB (65536 KiB)
 * - timeCost: 3 iterations
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MiB
    timeCost: 3,
    parallelism: 1,
  })
}

/** Verify a password against an argon2id hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password)
}
