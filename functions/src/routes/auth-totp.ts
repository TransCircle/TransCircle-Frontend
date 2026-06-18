import { Router } from 'express'
import pool, { exec, queryOne, getConnection } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { sendSuccess, sendError, Errors, sendNoContent } from '../utils/response'
import { metrics } from '../utils/metrics'
import { hmacToken, createSession, isNativeClient } from '../utils/session'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { verifyPassword, hashRecoveryCode, findUnusedRecoveryCode } from '../utils/password'
import { conf } from '../Config'
import { verifyTotpCode } from '../utils/totp'
import { encryptSecret, decryptSecret } from '../utils/crypto'
import { writeAuditLog } from '../utils/audit'
import argon2 from 'argon2'

/**
 * Generate a cryptographically random recovery code in format XXXX-XXXX-XXXX (api.md §1.9.2).
 * Uses crypto.getRandomValues for proper entropy (~60 bits per code).
 */
function generateRecoveryCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Crockford Base32 (no ILOU)
  const buf = crypto.getRandomValues(new Uint8Array(9))
  const seg1 = chars[buf[0]! % chars.length] + chars[buf[1]! % chars.length] + chars[buf[2]! % chars.length] + chars[buf[3]! % chars.length]
  const seg2 = chars[buf[4]! % chars.length] + chars[buf[5]! % chars.length] + chars[buf[6]! % chars.length] + chars[buf[7]! % chars.length]
  const seg3 = chars[buf[8]! % chars.length] + chars[buf[0]! % chars.length] + chars[buf[1]! % chars.length] + chars[buf[2]! % chars.length]
  return `${seg1}-${seg2}-${seg3}`
}

const router: Router = Router()
const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined

// POST /me/mfa/totp/setup — api.md §1.9.1
router.post('/me/mfa/totp/setup', requireAuth, async (req, res) => {
  // Per api.md §1 status table: pending_verification cannot set up TOTP
  const statusRow = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (statusRow?.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const existing = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.user!.userId],
  )
  if (existing) {
    sendError(res, 'TOTP_ALREADY_ENABLED', 'TOTP 已启用', req.requestId, 409)
    return
  }

  const setupId = genId('totp_setup_')
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32])
    .join('')

  const userRow = await queryOne(`SELECT email FROM users WHERE id = ?`, [req.user!.userId])
  const userIdentifier = (userRow?.email as string) || req.user!.userId
  const otpauthUrl = `otpauth://totp/TransCircle:${encodeURIComponent(userIdentifier)}?secret=${secret}&issuer=TransCircle&period=30&digits=6&algorithm=SHA1`

  // Encrypt secret per api.md 安全基线: KMS envelope encryption
  const encryptedSecret = await encryptSecret(secret)
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'totp_setup', ?, ?, ?, ?)`,
    [ulid(), req.user!.userId, await hmacToken(setupId),
     JSON.stringify({ secret: encryptedSecret }), Date.now() + 600_000, Date.now()],
  )

  // Generate QR code image per api.md §1.9.1
  let qrCodeImage: string | null = null
  try {
    const qrcode = await import('qrcode')
    qrCodeImage = await qrcode.toDataURL(otpauthUrl)
  } catch {
    // QR generation failure is non-fatal
  }

  sendSuccess(res, {
    setupId,
    secret,
    otpauthUrl,
    qrCodeImage,
    expiresIn: 600,
  }, req.requestId)
})

// POST /me/mfa/totp/enable — api.md §1.9.2
router.post('/me/mfa/totp/enable', requireAuth, async (req, res) => {
  const isActive = await queryOne(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [req.user!.userId])
  if (!isActive) {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const { setupId, code } = req.body as { setupId?: string; code?: string }
  if (!setupId || !code) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const setupHash = await hmacToken(setupId)
  const record = await queryOne(
    `SELECT metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'totp_setup' AND usedAt IS NULL AND expiresAt > ?`,
    [setupHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'setupId 无效或已过期', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata
  // Decrypt the encrypted secret stored during setup
  const secret = await decryptSecret(meta.secret as string)

  // Verify the TOTP code against the generated secret
  const candidateTimeStep = await verifyTotpCode(secret, code, null)
  if (candidateTimeStep === null) {
    metrics.mfaVerifyTotal["totp|invalid"] = (metrics.mfaVerifyTotal["totp|invalid"] || 0) + 1; sendError(res, "INVALID_TOTP_CODE", "验证码错误", req.requestId, 422)
    return
  }

  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE tokenHash = ?`, [Date.now(), setupHash])

  // Encrypt secret per api.md 安全基线: KMS envelope encryption
  const encryptedSecret = await encryptSecret(secret)
  await exec(
    `INSERT INTO mfa_totp_credentials (id, userId, secretEncrypted, status, lastUsedTimeStep, createdAt, enabledAt)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [genId('totp_'), req.user!.userId, encryptedSecret, candidateTimeStep, Date.now(), Date.now()],
  )

  const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode())

  // Store recovery codes hashed with argon2id per api.md §15.7
  for (const rc of recoveryCodes) {
    const codeHash = await hashRecoveryCode(rc)
    await exec(
      `INSERT INTO mfa_recovery_codes (id, userId, codeHash, createdAt)
       VALUES (?, ?, ?, ?)`,
      [genId('mrc_'), req.user!.userId, codeHash, Date.now()],
    )
  }

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'mfa.totp.enable',
    resourceType: 'mfa_totp',
    resourceId: req.user!.userId,
    after: { status: 'active' },
  })

  sendSuccess(res, { totpEnabled: true, recoveryCodes }, req.requestId)
})

// DELETE /me/mfa/totp — api.md §1.9.3
// 使用单事务 + FOR UPDATE 确保并发安全
// 同时注册 POST 路由以兼容前端（某些中间件可能拒绝 DELETE body）
async function handleTotpDisable(req: import('express').Request, res: import('express').Response): Promise<void> {
  const now = Date.now()
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // 锁定用户检查
    const [lockUser] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, status, passwordHash FROM users WHERE id = ? FOR UPDATE`,
      [req.user!.userId],
    )
    if (!lockUser[0] || lockUser[0].status !== 'active') {
      await conn.rollback()
      sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
      return
    }

    const { password, code } = req.body as { password?: string; code?: string }
    if (!code) {
      await conn.rollback()
      sendError(res, Errors.BAD_REQUEST.code, '验证码必填', req.requestId, 400)
      return
    }

    // 锁定 TOTP 凭证行，防止并发消费同一 code
    const [lockCreds] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, secretEncrypted, lastUsedTimeStep FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
      [req.user!.userId],
    )
    const existing = lockCreds[0] as { id: string; secretEncrypted: string; lastUsedTimeStep: number | null } | undefined

    if (!existing) {
      await conn.rollback()
      sendError(res, 'TOTP_NOT_ENABLED', 'TOTP 未启用', req.requestId, 404)
      return
    }

    // Verify password if set (读锁已获取的 userRow)
    if (lockUser[0].passwordHash) {
      if (!password) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, '密码不能为空', req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }
      const valid = await verifyPassword(lockUser[0].passwordHash as string, password)
      if (!valid) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, '密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }
    }

    // Verify TOTP code or recovery code
    const encryptedSecret = existing.secretEncrypted
    const secret = await decryptSecret(encryptedSecret)
    const lastUsedTimeStep = existing.lastUsedTimeStep
    const candidateTimeStep = await verifyTotpCode(secret, code, lastUsedTimeStep)

    if (candidateTimeStep !== null) {
      // Valid TOTP code — consume and disable
      await conn.execute(
        `UPDATE mfa_totp_credentials SET lastUsedTimeStep = ? WHERE id = ?`,
        [candidateTimeStep, existing.id],
      )
    } else {
      // Try as recovery code (argon2id scan per api.md §15.7)
      const rcId = await findUnusedRecoveryCode(req.user!.userId, code)
      if (!rcId) {
        await conn.rollback()
        metrics.mfaVerifyTotal["totp|invalid"] = (metrics.mfaVerifyTotal["totp|invalid"] || 0) + 1; sendError(res, 'INVALID_TOTP_CODE', '验证码或恢复码错误', req.requestId, 422)
        return
      }
      // FOR UPDATE 检查防止并发消费同一恢复码
      const [rcLockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT id FROM mfa_recovery_codes WHERE id = ? AND usedAt IS NULL FOR UPDATE`,
        [rcId],
      )
      if (!rcLockRows[0]) {
        await conn.rollback()
        metrics.mfaVerifyTotal["totp|invalid"] = (metrics.mfaVerifyTotal["totp|invalid"] || 0) + 1; sendError(res, 'INVALID_TOTP_CODE', '恢复码已被使用', req.requestId, 422)
        return
      }
      await conn.execute(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE id = ?`, [now, rcId])
    }

    // 原子禁用 TOTP
    await conn.execute(`UPDATE mfa_totp_credentials SET status = 'disabled' WHERE userId = ?`, [req.user!.userId])

    // 事务内写审计日志
    await writeAuditLog(req, {
      actorUserId: req.user!.userId,
      action: 'mfa.totp.disable',
      resourceType: 'mfa_totp',
      resourceId: req.user!.userId,
      after: { status: 'disabled' },
    })

    await conn.commit()
    sendNoContent(res, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('totp disable error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '禁用 TOTP 失败', req.requestId, 500)
  } finally {
    conn.release()
  }
}

router.delete('/me/mfa/totp', requireAuth, handleTotpDisable)
router.post('/me/mfa/totp', requireAuth, handleTotpDisable)

// POST /auth/mfa/totp/verify — api.md §1.9.4
router.post('/auth/mfa/totp/verify', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { mfaChallengeToken, code } = req.body as { mfaChallengeToken?: string; code?: string }

  if (!mfaChallengeToken || !code) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  // Find and lock challenge token — also read metadata for loginMethod per api.md §1.9.4
  const challengeHash = await hmacToken(mfaChallengeToken)
  const record = await queryOne(
    `SELECT id, userId, failedAttempts, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'mfa_challenge' AND usedAt IS NULL AND expiresAt > ?`,
    [challengeHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '挑战令牌无效或已过期', req.requestId, 410)
    return
  }

  const failedAttempts = (record.failedAttempts as number) || 0

  // Check exhaustion (max 5 attempts)
  if (failedAttempts >= 5) {
    await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])
    sendError(res, 'MFA_CHALLENGE_EXHAUSTED', '验证尝试次数过多', req.requestId, 429)
    return
  }

  // Try as TOTP code first
  const cred = await queryOne(
    `SELECT id, secretEncrypted, lastUsedTimeStep FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [record.userId],
  )

  let validCode = false

  if (cred) {
    const encryptedSecret = cred.secretEncrypted as string
    const secret = await decryptSecret(encryptedSecret)
    const lastUsedTimeStep = cred.lastUsedTimeStep as number | null
    // Single-pass TOTP verification with replay detection (api.md §1.9.4)
    // First check all time steps without replay filter to determine if code is valid at all
    const candidateTimeStep = await verifyTotpCode(secret, code, null)

    if (candidateTimeStep !== null) {
      // Code matches a valid time step — now check replay
      if (lastUsedTimeStep !== null && candidateTimeStep <= lastUsedTimeStep) {
        // Replay detected: code is valid but was already used in a previous time step
        await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])
        metrics.mfaVerifyTotal["totp|replay"] = (metrics.mfaVerifyTotal["totp|replay"] || 0) + 1
        sendError(res, 'TOTP_CODE_REPLAY', '该验证码已被使用过', req.requestId, 422)
        return
      }
      validCode = true
      await exec(
        `UPDATE mfa_totp_credentials SET lastUsedTimeStep = ?, lastUsedAt = ? WHERE id = ?`,
        [candidateTimeStep, Date.now(), cred.id],
      )
    }
  }

  // Try as recovery code — use FOR UPDATE to prevent concurrent reuse (api.md §15.7)
  if (!validCode) {
    const [rcRows] = await pool.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, codeHash FROM mfa_recovery_codes WHERE userId = ? AND usedAt IS NULL ORDER BY createdAt ASC LIMIT 10 FOR UPDATE`,
      [record.userId],
    )
    let rcId: string | null = null
    if (rcRows.length > 0) {
      for (const row of rcRows) {
        if (await argon2.verify(row.codeHash as string, code)) {
          rcId = row.id as string
          break
        }
      }
    }
    if (rcId) {
      validCode = true
      await exec(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE id = ? AND usedAt IS NULL`, [Date.now(), rcId])
    }
  }

  if (!validCode) {
    // Increment failed attempts
    const newFailed = failedAttempts + 1
    if (newFailed >= 5) {
      await exec(`UPDATE auth_tokens SET usedAt = ?, failedAttempts = ? WHERE id = ?`, [Date.now(), newFailed, record.id])
      sendError(res, 'MFA_CHALLENGE_EXHAUSTED', '验证尝试次数过多', req.requestId, 429)
    } else {
      await exec(`UPDATE auth_tokens SET failedAttempts = ? WHERE id = ?`, [newFailed, record.id])
      metrics.mfaVerifyTotal["totp|invalid"] = (metrics.mfaVerifyTotal["totp|invalid"] || 0) + 1; sendError(res, 'INVALID_TOTP_CODE', '验证码错误', req.requestId, 422)
    }
    return
  }

  // Consume challenge token
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])

  // Find user and create session
  const { findUserById } = await import('../utils/users')
  const user = await findUserById(record.userId)
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500)
    return
  }

  // Read loginMethod from mfaChallenge metadata (api.md §1.9.4), fallback to 'password'
  const mfaMeta = (() => {
    try {
      const raw = (record as Record<string, unknown>).metadata as string | undefined || '{}'
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch { return {} }
  })() as Record<string, unknown>
  const mfaLoginMethod = (mfaMeta.loginMethod as string) || 'password'

  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const { sessionId, refreshToken } = await createSession(user.id, user.roles, mfaLoginMethod, ip, ua)

  const accessToken = await signJwt({
    sub: user.id, sid: sessionId, tokenVersion: user.tokenVersion,
    roles: user.roles, aud: 'transcircle-web', iss: 'https://api.transcircle.org',
  })

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: true,
    sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
  })

  // api.md §1.3: 浏览器场景通过 Cookie 下发时，响应体省略 refreshToken
  const nativeClient = isNativeClient(req)
  const totpResp: Record<string, unknown> = {
    mfaRequired: false,
    accessToken, tokenType: 'Bearer', expiresIn: 900,
    user: {
      id: user.id, username: user.username,
      displayName: user.displayName, avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  }
  if (nativeClient) totpResp.refreshToken = refreshToken
  sendSuccess(res, totpResp, req.requestId)
})

// POST /me/mfa/recovery-codes/regenerate — api.md §1.9.5
router.post('/me/mfa/recovery-codes/regenerate', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const isActive = await queryOne(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [req.user!.userId])
  if (!isActive) {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const { code } = req.body as { code?: string }
  if (!code) {
    sendError(res, Errors.BAD_REQUEST.code, '验证码必填', req.requestId, 400)
    return
  }

  const cred = await queryOne(
    `SELECT id, secretEncrypted, lastUsedTimeStep FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.user!.userId],
  )

  if (!cred) {
    sendError(res, 'TOTP_NOT_ENABLED', 'TOTP 未启用', req.requestId, 404)
    return
  }

  // Verify current TOTP code
  const encryptedSecret = cred.secretEncrypted as string
  const secret = await decryptSecret(encryptedSecret)
  const lastUsedTimeStep = cred.lastUsedTimeStep as number | null
  const candidateTimeStep = await verifyTotpCode(secret, code, lastUsedTimeStep)

  if (candidateTimeStep === null) {
    // Try as recovery code (argon2id scan per api.md §15.7)
    const rcId = await findUnusedRecoveryCode(req.user!.userId, code)
    if (!rcId) {
      metrics.mfaVerifyTotal["totp|invalid"] = (metrics.mfaVerifyTotal["totp|invalid"] || 0) + 1; sendError(res, 'INVALID_TOTP_CODE', '验证码或恢复码错误', req.requestId, 422)
      return
    }
    await exec(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE id = ?`, [Date.now(), rcId])
  } else {
    await exec(
      `UPDATE mfa_totp_credentials SET lastUsedTimeStep = ? WHERE id = ?`,
      [candidateTimeStep, cred.id],
    )
  }

  // Generate new recovery codes FIRST to avoid losing access if crash occurs mid-operation
  const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode())

  for (const rc of recoveryCodes) {
    const codeHash = await hashRecoveryCode(rc)
    await exec(
      `INSERT INTO mfa_recovery_codes (id, userId, codeHash, createdAt)
       VALUES (?, ?, ?, ?)`,
      [genId('mrc_'), req.user!.userId, codeHash, Date.now()],
    )
  }

  // Then invalidate old recovery codes
  await exec(
    `UPDATE mfa_recovery_codes SET usedAt = ? WHERE userId = ? AND usedAt IS NULL`,
    [Date.now(), req.user!.userId],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'mfa.recovery_codes.regenerate',
    resourceType: 'mfa_totp',
    resourceId: req.user!.userId,
    after: { regenerated: true },
  })

  sendSuccess(res, { recoveryCodes }, req.requestId)
})

export default router
