import { Router } from 'express'
import { exec, query, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { hmacToken } from '../utils/session'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { verifyPassword, findUnusedRecoveryCode } from '../utils/password'
import { verifyTotpCode } from '../utils/totp'
import { decryptSecret } from '../utils/crypto'
import { writeAuditLog, canonicalJson, sha256base64url } from '../utils/audit'
import { conf } from '../Config'
import { Buffer } from 'node:buffer'

const router: Router = Router()

// POST /auth/step-up/start — api.md §1.12.1
router.post('/auth/step-up/start', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  // Check user status per spec
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (!user) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }
  if (user.status === 'banned') {
    sendError(res, Errors.ACCOUNT_BANNED.code, Errors.ACCOUNT_BANNED.message, req.requestId, Errors.ACCOUNT_BANNED.status)
    return
  }
  if (user.status === 'pending_verification') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, Errors.EMAIL_NOT_VERIFIED.message, req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }
  if (user.status === 'merged') {
    sendError(res, Errors.ACCOUNT_MERGED.code, Errors.ACCOUNT_MERGED.message, req.requestId, Errors.ACCOUNT_MERGED.status)
    return
  }
  if (user.status === 'pending_deletion') {
    sendError(res, Errors.ACCOUNT_PENDING_DELETION.code, Errors.ACCOUNT_PENDING_DELETION.message, req.requestId, Errors.ACCOUNT_PENDING_DELETION.status)
    return
  }
  if (user.status === 'deleted') {
    sendError(res, Errors.ACCOUNT_DELETED.code, Errors.ACCOUNT_DELETED.message, req.requestId, Errors.ACCOUNT_DELETED.status)
    return
  }

  const challengeId = genId('stepup_')
  const challengeHash = await hmacToken(challengeId)

  // Determine available methods per api.md §1.12.1
  const availableMethods: string[] = []

  const hasPassword = await queryOne(
    `SELECT passwordHash FROM users WHERE id = ? AND passwordHash IS NOT NULL`,
    [req.user!.userId],
  )
  if (hasPassword) availableMethods.push('password')

  const hasTotp = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.user!.userId],
  )
  if (hasTotp) availableMethods.push('totp')

  const hasPasskey = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )
  const passkeyCount = (hasPasskey?.cnt as number) || 0
  if (passkeyCount > 0) availableMethods.push('passkey')

  const passkeyChallengeMeta: Record<string, unknown> = {}

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'step_up_challenge', ?, '{}', ?, ?)`,
    [ulid(), req.user!.userId, challengeHash, Date.now() + 300_000, Date.now()],
  )

  if (passkeyCount > 0) {
    const creds = await query(
      `SELECT credentialIdB64, transports FROM passkeys WHERE userId = ? AND status = 'active'`,
      [req.user!.userId],
    ) as unknown as Array<{ credentialIdB64: string; transports: string }>;

    const allowCredentials = creds.map((c) => ({
      id: c.credentialIdB64,
      transports: (() => { try { return JSON.parse(c.transports as string) as string[] } catch { return [] } })(),
    }))

    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')
    const authOptions = await generateAuthenticationOptions({
      rpID: 'transcircle.org',
      userVerification: 'required',
      allowCredentials: allowCredentials as unknown as Parameters<typeof generateAuthenticationOptions>[0]['allowCredentials'],
      timeout: 60000,
    })

    await exec(
      `UPDATE auth_tokens SET metadata = ? WHERE tokenHash = ?`,
      [JSON.stringify({ challenge: authOptions.challenge, passkey: true }), challengeHash],
    )

    passkeyChallengeMeta.publicKey = {
      challenge: authOptions.challenge,
      rpId: 'transcircle.org',
      userVerification: 'required',
      allowCredentials,
    }
  }

  const responseData: Record<string, unknown> = {
    challengeId,
    expiresIn: 300,
    availableMethods,
  }
  if (passkeyCount > 0 && passkeyChallengeMeta.publicKey) {
    responseData.passkey = passkeyChallengeMeta
  }

  sendSuccess(res, responseData, req.requestId)
})

// POST /auth/step-up/verify — api.md §1.12.2
// Must use transaction + SELECT FOR UPDATE for concurrency safety
router.post('/auth/step-up/verify', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { challengeId, method, password, code, passkeyAssertion } = req.body as {
    challengeId?: string; method?: string; password?: string; code?: string
    passkeyAssertion?: {
      id: string; rawId: string; type: string
      response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string }
      clientExtensionResults?: Record<string, unknown>
    }
  }

  if (!challengeId || !method) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const challengeHash = await hmacToken(challengeId)

  // Per api.md §1.12.2: single transaction with row-level lock
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, userId, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'step_up_challenge' AND usedAt IS NULL AND expiresAt > ?
       FOR UPDATE`,
      [challengeHash, Date.now()],
    )

    const rows = lockRows as unknown as Array<{ id: string; userId: string; metadata: string }>
    const record = rows[0] ?? null

    if (!record || record.userId !== req.user!.userId) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '挑战令牌无效', req.requestId, 410)
      return
    }

    // Read challenge metadata for passkey flow
    const meta = (() => {
      try {
        const raw = record.metadata
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> || {})
      } catch { return {} }
    })() as Record<string, unknown>

    // --- Method verification (read-only checks, can fail before commiting) ---

    // First verify the method is available to this user per api.md §1.12.2
    const availableMethods: string[] = []
    const hasPwd = await queryOne(`SELECT passwordHash FROM users WHERE id = ? AND passwordHash IS NOT NULL`, [req.user!.userId])
    if (hasPwd) availableMethods.push('password')
    const hasTotp = await queryOne(`SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`, [req.user!.userId])
    if (hasTotp) availableMethods.push('totp', 'recovery_code')
    const pkCount = await queryOne(`SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`, [req.user!.userId])
    if ((pkCount?.cnt as number || 0) > 0) availableMethods.push('passkey')

    if (!availableMethods.includes(method)) {
      await conn.rollback()
      sendError(res, Errors.BAD_REQUEST.code, `该账户不可用 ${method} 验证方式`, req.requestId, 400)
      return
    }

    if (method === 'password') {
      if (!password) {
        await conn.rollback()
        sendError(res, Errors.BAD_REQUEST.code, '密码不能为空', req.requestId, 400)
        return
      }

      const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [req.user!.userId])
      if (!userRow?.passwordHash) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }

      const valid = await verifyPassword(userRow.passwordHash as string, password)
      if (!valid) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }
    } else if (method === 'totp' || method === 'recovery_code') {
      if (!code) {
        await conn.rollback()
        sendError(res, Errors.BAD_REQUEST.code, '验证码不能为空', req.requestId, 400)
        return
      }

      const cred = await queryOne(
        `SELECT id, secretEncrypted, lastUsedTimeStep FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
        [req.user!.userId],
      )
      if (!cred) {
        await conn.rollback()
        sendError(res, 'TOTP_NOT_ENABLED', 'TOTP 未启用', req.requestId, 404)
        return
      }

      if (method === 'totp') {
        const encryptedSecret = cred.secretEncrypted as string
        const secret = await decryptSecret(encryptedSecret)
        const lastUsedTimeStep = cred.lastUsedTimeStep as number | null
        const candidateTimeStep = await verifyTotpCode(secret, code, lastUsedTimeStep)
        if (candidateTimeStep === null) {
          await conn.rollback()
          sendError(res, 'INVALID_TOTP_CODE', '验证码错误', req.requestId, 422)
          return
        }
        await conn.execute(
          `UPDATE mfa_totp_credentials SET lastUsedTimeStep = ? WHERE id = ?`,
          [candidateTimeStep, cred.id],
        )
      } else {
        // recovery_code (argon2id scan per api.md §15.7)
        const rcIdFromPool = await findUnusedRecoveryCode(req.user!.userId, code)
        if (!rcIdFromPool) {
          await conn.rollback()
          sendError(res, 'INVALID_TOTP_CODE', '恢复码错误', req.requestId, 422)
          return
        }
        // Double-check within transaction to prevent race
        const [rcCheckRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
          `SELECT id, usedAt FROM mfa_recovery_codes WHERE id = ? FOR UPDATE`,
          [rcIdFromPool],
        )
        if (!rcCheckRows[0] || rcCheckRows[0].usedAt) {
          await conn.rollback()
          sendError(res, 'INVALID_TOTP_CODE', '恢复码已被使用', req.requestId, 422)
          return
        }
        await conn.execute(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE id = ?`, [Date.now(), rcCheckRows[0].id])
      }
    } else if (method === 'passkey') {
      if (!passkeyAssertion) {
        await conn.rollback()
        sendError(res, Errors.BAD_REQUEST.code, 'passkeyAssertion 不能为空', req.requestId, 400)
        return
      }

      const expectedChallenge = meta.challenge as string | undefined
      if (!expectedChallenge) {
        await conn.rollback()
        sendError(res, 'PASSKEY_VERIFICATION_FAILED', '缺少 step-up 挑战数据', req.requestId, 422)
        return
      }

      const storedCred = await queryOne(
        `SELECT id, userId, credentialId, credentialIdB64, publicKey, signCount, signCountSupported, status
         FROM passkeys WHERE userId = ? AND status = 'active'`,
        [req.user!.userId],
      )

      if (!storedCred) {
        await conn.rollback()
        sendError(res, 'PASSKEY_VERIFICATION_FAILED', '未找到活跃的 Passkey', req.requestId, 422)
        return
      }

      if (storedCred.status === 'frozen') {
        await conn.rollback()
        sendError(res, 'PASSKEY_FROZEN', 'Passkey 已被冻结', req.requestId, 403)
        return
      }

      const pkHex = storedCred.publicKey as string
      let credentialPublicKey: Uint8Array<ArrayBuffer>
      try {
        credentialPublicKey = new Uint8Array(Buffer.from(pkHex, 'hex')) as unknown as Uint8Array<ArrayBuffer>
      } catch {
        await conn.rollback()
        sendError(res, Errors.INTERNAL_ERROR.code, '凭证数据异常', req.requestId, 500)
        return
      }

      const { verifyAuthenticationResponse } = await import('@simplewebauthn/server')
      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response: {
            id: passkeyAssertion.id, rawId: passkeyAssertion.rawId, type: passkeyAssertion.type as 'public-key',
            response: {
              clientDataJSON: passkeyAssertion.response.clientDataJSON,
              authenticatorData: passkeyAssertion.response.authenticatorData,
              signature: passkeyAssertion.response.signature,
              userHandle: passkeyAssertion.response.userHandle,
            },
            clientExtensionResults: passkeyAssertion.clientExtensionResults || {},
          },
          expectedChallenge,
          expectedOrigin: (conf.APP as Record<string, string | undefined> | undefined)?.FRONTEND_URL || 'https://submit.transcircle.org',
          expectedRPID: 'transcircle.org',
          credential: { id: storedCred.id, publicKey: credentialPublicKey, counter: storedCred.signCount as number },
          requireUserVerification: true,
        })
      } catch {
        await conn.rollback()
        sendError(res, 'PASSKEY_VERIFICATION_FAILED', 'Passkey 验证异常', req.requestId, 422)
        return
      }

      if (!verification.verified) {
        await conn.rollback()
        sendError(res, 'PASSKEY_VERIFICATION_FAILED', 'Passkey 签名验证失败', req.requestId, 422)
        return
      }

      const { authenticationInfo } = verification
      const currentSignCount = storedCred.signCount as number
      const newSignCount = authenticationInfo.newCounter

      if (newSignCount > 0) {
        const sigCountSupported = storedCred.signCountSupported as boolean
        if (sigCountSupported && newSignCount <= currentSignCount) {
          await conn.rollback()
          // Freeze the passkey and audit outside the verification transaction
          exec(`UPDATE passkeys SET status = 'frozen', frozenReason = 'signcount_replay' WHERE id = ?`, [storedCred.id]).catch(() => {})
          writeAuditLog(req, {
            actorUserId: req.user!.userId,
            action: 'passkey.freeze',
            resourceType: 'passkey',
            resourceId: storedCred.id,
            after: { reason: 'signcount_replay', previousSignCount: currentSignCount },
          }).catch((e: unknown) => console.error('audit error:', e))
          sendError(res, 'PASSKEY_REPLAY_DETECTED', 'Passkey 回放检测，已冻结', req.requestId, 422)
          return
        }
        await conn.execute(`UPDATE passkeys SET signCount = ? WHERE id = ?`, [newSignCount, storedCred.id])
      }
    } else {
      await conn.rollback()
      sendError(res, Errors.BAD_REQUEST.code, '不支持的验证方法', req.requestId, 400)
      return
    }

    // --- All verification passed — commit side effects atomically ---

    const now = Date.now()

    // Mark challenge as used
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, record.id])

    // Update session lastStepUpAt
    await conn.execute(
      `UPDATE sessions SET lastStepUpAt = ?, lastStepUpMethod = ? WHERE id = ?`,
      [now, method, req.user!.sessionId],
    )

    // Audit log entry within the same transaction (per api.md §15.13)
    const auditIp = req.ip || req.socket.remoteAddress || 'unknown'
    const auditUa = req.headers['user-agent'] || 'unknown'
    const stepupAuditId = genId('aud_')
    const [lastStepupAudit] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT entryHash FROM audit_logs ORDER BY createdAt DESC LIMIT 1 FOR UPDATE`,
    )
    const stepupPrevHash = (lastStepupAudit[0]?.entryHash as string) ?? null
    const stepupAfterData = { method }
    const stepupRecordData = {
      id: stepupAuditId, actorUserId: req.user!.userId, action: 'auth.step_up',
      resourceType: 'session', resourceId: req.user!.sessionId,
      before: null, after: stepupAfterData, metadata: {},
      createdAt: now, requestId: req.requestId,
      ipHash: await hmacToken(auditIp), uaHash: await hmacToken(auditUa),
    }
    const stepupCanonicalRecord = canonicalJson(stepupRecordData)
    const stepupChainInput = stepupPrevHash ? `${stepupPrevHash}|${stepupCanonicalRecord}` : stepupCanonicalRecord
    const stepupEntryHash = await sha256base64url(stepupChainInput)
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'auth.step_up', 'session', ?, NULL, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [stepupAuditId, req.user!.userId, req.user!.sessionId,
       canonicalJson(stepupAfterData), now, req.requestId,
       await hmacToken(auditIp), await hmacToken(auditUa),
       stepupPrevHash, stepupEntryHash],
    )

    await conn.commit()

    sendSuccess(res, {
      stepUpAt: now,
      method,
      validForSeconds: 300,
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('step-up verify error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '验证失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

export default router
