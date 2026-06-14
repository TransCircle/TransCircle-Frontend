import argon2 from 'argon2'
import { query } from '../Database'

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

/**
 * Hash a recovery code using argon2id (api.md §15.7).
 * Recovery codes are stored as argon2id hashes, not HMAC,
 * so a compromised DB dump doesn't reveal the plaintext codes.
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(code)
}

/**
 * Find and consume an unused recovery code for a user.
 * Scans all unused codes and tries argon2id.verify on each.
 * Returns the matching record id, or null if none match.
 *
 * Limits the number of verification attempts to prevent DOS via
 * argon2's expensive verification loop.
 *
 * Caller must mark usedAt in a transaction after this returns a match.
 */
const MAX_RECOVERY_VERIFY_ATTEMPTS = 3

export async function findUnusedRecoveryCode(userId: string, code: string): Promise<string | null> {
  const rows = await query(
    `SELECT id, codeHash FROM mfa_recovery_codes WHERE userId = ? AND usedAt IS NULL ORDER BY createdAt ASC`,
    [userId],
  ) as unknown as Array<{ id: string; codeHash: string }>

  if (!rows || rows.length === 0) return null

  let attempts = 0
  for (const row of rows) {
    if (attempts >= MAX_RECOVERY_VERIFY_ATTEMPTS) break
    attempts++
    if (await argon2.verify(row.codeHash, code)) {
      return row.id
    }
  }
  return null
}
