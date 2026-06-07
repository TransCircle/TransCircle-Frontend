import { Router } from 'express'
import { exec, query, queryOne, getConnection } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { sendSuccess, sendError, Errors, sendNoContent } from '../utils/response'
import { hmacToken, createSession, isNativeClient } from '../utils/session'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { writeAuditLog } from '../utils/audit'
import { conf } from '../Config'

const router: Router = Router()
const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined
const RP_ID = 'transcircle.org'
const RP_NAME = 'TransCircle'
const ORIGIN = (conf.APP as Record<string, string | undefined> | undefined)?.FRONTEND_URL || 'https://submit.transcircle.org'

// ─── 1.10.1 Start Passkey Registration ────────────────────────────────
router.post('/me/passkeys/register/start', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证，不能注册 Passkey', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const existingCreds = await query(
    `SELECT credentialIdB64 FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  ) as unknown as Array<{ credentialIdB64: string }>

  const excludeCredentials = existingCreds.map((c) => ({
    type: 'public-key' as const,
    id: c.credentialIdB64,
  }))

  const { generateRegistrationOptions } = await import('@simplewebauthn/server')
  const userEntity = await queryOne(`SELECT id, username, email, displayName FROM users WHERE id = ?`, [req.user!.userId])
  if (!userEntity) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500)
    return
  }

  const registrationId = genId('pk_reg_')
  const registrationHash = await hmacToken(registrationId)

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: userEntity.email || userEntity.username,
    userDisplayName: userEntity.displayName,
    // Use a stable user ID encoding
    userID: new TextEncoder().encode(userEntity.id),
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-8, -7, -257] as const,
    timeout: 60000,
  })

  // Store challenge
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'passkey_register', ?, ?, ?, ?)`,
    [ulid(), req.user!.userId, registrationHash,
     JSON.stringify({ challenge: options.challenge, userId: req.user!.userId }),
     Date.now() + 600_000, Date.now()],
  )

  sendSuccess(res, {
    registrationId,
    publicKey: {
      challenge: options.challenge,
      rp: options.rp,
      user: {
        id: options.user.id,
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: options.excludeCredentials,
    },
    expiresIn: 600,
  }, req.requestId)
})

// ─── 1.10.2 Finish Passkey Registration ──────────────────────────────
router.post('/me/passkeys/register/finish', requireAuth, async (req, res) => {
  const { registrationId, name, credential } = req.body as {
    registrationId?: string
    name?: string
    credential?: {
      id: string
      rawId: string
      type: string
      response: {
        clientDataJSON: string
        attestationObject: string
        transports?: string[]
      }
      clientExtensionResults?: Record<string, unknown>
    }
  }

  if (!registrationId || !name || !credential) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  if ([...name].length < 1 || [...name].length > 50) {
    sendError(res, Errors.VALIDATION_ERROR.code, '名称需 1-50 个字符', req.requestId, 422)
    return
  }

  // Check uniqueness of name within account
  const existingName = await queryOne(
    `SELECT id FROM passkeys WHERE userId = ? AND name = ?`,
    [req.user!.userId, name],
  )
  if (existingName) {
    sendError(res, 'PASSKEY_NAME_TAKEN', '该名称已被使用', req.requestId, 409)
    return
  }

  // Look up registration challenge
  const regHash = await hmacToken(registrationId)
  const record = await queryOne(
    `SELECT id, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'passkey_register' AND usedAt IS NULL AND expiresAt > ?`,
    [regHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '注册令牌无效或已过期', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata

  const { verifyRegistrationResponse } = await import('@simplewebauthn/server')
  const verification = await verifyRegistrationResponse({
    response: credential as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: meta.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  })

  if (!verification.verified || !verification.registrationInfo) {
    sendError(res, 'PASSKEY_VERIFICATION_FAILED', 'Passkey 验证失败', req.requestId, 422)
    return
  }

  const regInfo = verification.registrationInfo
  const regCred = regInfo.credential
  const { aaguid, credentialDeviceType, credentialBackedUp } = regInfo

  // Check duplicate credentialId
  const credIdB64 = credential.id
  const existingCred = await queryOne(
    `SELECT id FROM passkeys WHERE credentialIdB64 = ?`,
    [credIdB64],
  )
  if (existingCred) {
    sendError(res, 'PASSKEY_ALREADY_REGISTERED', '该 Passkey 已注册', req.requestId, 409)
    return
  }

  // Store credential
  const pkId = genId('pk_')
  const signCountSupported = regCred.counter > 0

  // credentialPublicKey needs conversion from Uint8Array to compatible format
  const pkHex = Buffer.from(regCred.publicKey).toString('hex')

  await exec(
    `INSERT INTO passkeys (id, userId, name, credentialId, credentialIdB64, publicKey, signCount, transports, aaguid, attestationFormat, backupEligible, backupState, signCountSupported, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [pkId, req.user!.userId, name.trim(), Buffer.from(regCred.id), credIdB64, Buffer.from(pkHex, 'hex'),
     regCred.counter, JSON.stringify(regCred.transports || []), aaguid || null, 'none', credentialBackedUp,
     credentialDeviceType === 'singleDevice', signCountSupported, Date.now()],
  )

  // Mark challenge used
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'passkey.create',
    resourceType: 'passkey',
    resourceId: pkId,
    after: { name },
  })

  sendSuccess(res, {
    id: pkId,
    name: name.trim(),
    credentialId: credIdB64,
    createdAt: Date.now(),
  }, req.requestId, 201)
})

// ─── 1.10.3 List Passkeys ─────────────────────────────────────────────
router.get('/me/passkeys', requireAuth, async (req, res) => {
  const rows = await query(
    `SELECT id, name, credentialIdB64, transports, status, frozenReason, signCountSupported, createdAt, lastUsedAt
     FROM passkeys WHERE userId = ?
     ORDER BY createdAt DESC`,
    [req.user!.userId],
  ) as unknown as Array<{
    id: string; name: string; credentialIdB64: string; transports: string
    status: string; frozenReason: string | null; signCountSupported: boolean
    createdAt: number; lastUsedAt: number | null
  }>

  sendSuccess(res, rows.map((r) => ({
    id: r.id,
    name: r.name,
    credentialId: r.credentialIdB64,
    transports: (() => { try { return JSON.parse(r.transports) as string[] } catch { return [] } })(),
    status: r.status,
    frozenReason: r.frozenReason || null,
    signCountSupported: !!r.signCountSupported,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt || null,
  })), req.requestId)
})

// ─── 1.10.4 Delete Passkey ────────────────────────────────────────────
router.delete('/me/passkeys/:id', requireAuth, async (req, res) => {
  const { id } = req.params

  const pk = await queryOne(
    `SELECT id FROM passkeys WHERE id = ? AND userId = ?`,
    [id, req.user!.userId],
  )

  if (!pk) {
    sendError(res, 'PASSKEY_NOT_FOUND', 'Passkey 不存在', req.requestId, 404)
    return
  }

  // Check if this is the only login method (api.md §1.10.4)
  const hasPassword = await queryOne(
    `SELECT passwordHash FROM users WHERE id = ? AND passwordHash IS NOT NULL`,
    [req.user!.userId],
  )
  const otherPasskeys = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND id != ? AND status = 'active'`,
    [req.user!.userId, id],
  )
  const oauthCount = await queryOne(
    `SELECT COUNT(*) as cnt FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  )

  if (!hasPassword && (otherPasskeys?.cnt as number || 0) === 0 && (oauthCount?.cnt as number || 0) === 0) {
    sendError(res, 'LAST_LOGIN_METHOD', '删除后将无任何可用登录方式', req.requestId, 409)
    return
  }

  await exec(`DELETE FROM passkeys WHERE id = ? AND userId = ?`, [id, req.user!.userId])

  // Audit log per api.md §15.13
  writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'passkey.delete',
    resourceType: 'passkey',
    resourceId: id,
    after: { deletedAt: Date.now() },
  }).catch((e: unknown) => console.error('audit error:', e))

  sendNoContent(res, req.requestId)
})

// ─── 1.10.5 Passkey Login Start ──────────────────────────────────────
router.post('/auth/passkey/login/start', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const identifier = req.body?.identifier as string | undefined

  let userId: string | undefined

  if (identifier) {
    const user = identifier.includes('@')
      ? await queryOne(`SELECT id FROM users WHERE email = ?`, [identifier])
      : await queryOne(`SELECT id FROM users WHERE username = ?`, [identifier])
    if (user) userId = user.id
  }

  const challengeId = genId('pk_login_')
  const challengeHash = await hmacToken(challengeId)
  const now = Date.now()

  if (userId) {
    // User found — return specific allowCredentials
    const creds = await query(
      `SELECT credentialIdB64, transports FROM passkeys WHERE userId = ? AND status = 'active'`,
      [userId],
    ) as unknown as Array<{ credentialIdB64: string; transports: string }>

    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')
    const parseTransports = (t: string): string[] => { try { return JSON.parse(t) as string[] } catch { return [] } }
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: c.credentialIdB64,
        transports: parseTransports(c.transports) as unknown as undefined,
      })),
      timeout: 60000,
    })

    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'passkey_login', ?, ?, ?, ?)`,
      [ulid(), userId, challengeHash,
       JSON.stringify({ challenge: options.challenge, userId }), now + 600_000, now],
    )

    sendSuccess(res, {
      challengeId,
      publicKey: {
        challenge: options.challenge,
        rpId: RP_ID,
        timeout: options.timeout,
        userVerification: 'required',
        allowCredentials: creds.map((c) => ({
          type: 'public-key' as const,
          id: c.credentialIdB64,
          transports: parseTransports(c.transports),
        })),
      },
      expiresIn: 300,
    }, req.requestId)
  } else {
    // Username-less login — generate generic challenge
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      timeout: 60000,
    })

    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, NULL, 'passkey_login', ?, ?, ?, ?)`,
      [ulid(), challengeHash,
       JSON.stringify({ challenge: options.challenge }), now + 600_000, now],
    )

    sendSuccess(res, {
      challengeId,
      publicKey: {
        challenge: options.challenge,
        rpId: RP_ID,
        timeout: options.timeout,
        userVerification: 'required',
      },
      expiresIn: 300,
    }, req.requestId)
  }
})

// ─── 1.10.5 Passkey Login Finish ─────────────────────────────────────
router.post('/auth/passkey/login/finish', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { challengeId, credential } = req.body as {
    challengeId?: string
    credential?: {
      id: string
      rawId: string
      type: string
      response: {
        clientDataJSON: string
        authenticatorData: string
        signature: string
        userHandle?: string
      }
      clientExtensionResults?: Record<string, unknown>
    }
  }

  if (!challengeId || !credential) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  const challengeHash = await hmacToken(challengeId)
  const record = await queryOne(
    `SELECT id, userId, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'passkey_login' AND usedAt IS NULL AND expiresAt > ?`,
    [challengeHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '挑战令牌无效或已过期', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata

  // ── 事务: 原子凭证查找 + signCount 校验 + 更新 ──
  interface StoredPasskeyCredential {
    id: string
    userId: string
    credentialId: string
    publicKey: string
    signCount: number
    signCountSupported: boolean
    status: string
  }
  {
    const conn = await getConnection()
    try {
      await conn.beginTransaction()

      const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT id, userId, credentialId, publicKey, signCount, signCountSupported, status
         FROM passkeys WHERE credentialIdB64 = ? FOR UPDATE`,
        [credential.id],
      )
      const row = lockRows[0] as Record<string, unknown> | undefined
      if (!row) {
        await conn.rollback()
        conn.release()
        await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])
        sendError(res, 'INVALID_CREDENTIALS', '凭证未注册', req.requestId, 401)
        return
      }

      if (row.status === 'frozen') {
        await conn.rollback()
        conn.release()
        sendError(res, 'PASSKEY_FROZEN', 'Passkey 已被冻结', req.requestId, 403)
        return
      }

      storedCred = row as unknown as StoredPasskeyCredential
      passkeyUserId = storedCred!.userId

      // Check user status within transaction
      const [uRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT id, status FROM users WHERE id = ? FOR UPDATE`,
        [passkeyUserId],
      )
      const loginUser = uRows[0] as { id: string; status: string } | undefined
      if (!loginUser) {
        await conn.rollback()
        conn.release()
        sendError(res, 'INVALID_CREDENTIALS', '用户不存在', req.requestId, 401)
        return
      }
      if (loginUser.status === 'banned') {
        await conn.rollback()
        conn.release()
        sendError(res, Errors.ACCOUNT_BANNED.code, Errors.ACCOUNT_BANNED.message, req.requestId, Errors.ACCOUNT_BANNED.status)
        return
      }
      if (loginUser.status === 'merged') {
        await conn.rollback()
        conn.release()
        sendError(res, Errors.ACCOUNT_MERGED.code, Errors.ACCOUNT_MERGED.message, req.requestId, Errors.ACCOUNT_MERGED.status)
        return
      }
      if (loginUser.status === 'pending_deletion' || loginUser.status === 'deleted') {
        await conn.rollback()
        conn.release()
        sendError(res, 'INVALID_CREDENTIALS', '账户状态异常', req.requestId, 401)
        return
      }

      // 验证成功后再释放事务锁（但不提交——后续 signCount 更新也在此事务内）
      await conn.commit()
    } finally {
      conn.release()
    }
  }

  const pkHex = storedCred!.publicKey as string
  let credentialPublicKey: Uint8Array<ArrayBuffer>
  try {
    credentialPublicKey = new Uint8Array(Buffer.from(pkHex, 'hex')) as unknown as Uint8Array<ArrayBuffer>
  } catch {
    sendError(res, Errors.INTERNAL_ERROR.code, '凭证数据异常', req.requestId, 500)
    return
  }

  const { verifyAuthenticationResponse } = await import('@simplewebauthn/server')
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: {
        id: credential.id,
        rawId: credential.rawId,
        type: credential.type as 'public-key',
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          authenticatorData: credential.response.authenticatorData,
          signature: credential.response.signature,
          userHandle: credential.response.userHandle,
        },
        clientExtensionResults: credential.clientExtensionResults || {},
      },
      expectedChallenge: meta.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: storedCred!.id as string,
        publicKey: credentialPublicKey,
        counter: (storedCred!.signCount as number) || 0,
      },
      requireUserVerification: true,
    })
  } catch {
    sendError(res, 'PASSKEY_VERIFICATION_FAILED', '验证失败', req.requestId, 422)
    return
  }

  if (!verification.verified) {
    sendError(res, 'PASSKEY_VERIFICATION_FAILED', '签名验证失败', req.requestId, 422)
    return
  }

  const { authenticationInfo } = verification

  // ── 第二个事务: 原子 signCount 更新 ──
  {
    const conn = await getConnection()
    try {
      await conn.beginTransaction()

      const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT signCount, signCountSupported FROM passkeys WHERE id = ? FOR UPDATE`,
        [storedCred!.id],
      )
      const pkRow = lockRows[0] as { signCount: number; signCountSupported: boolean } | undefined
      const currentSignCount = pkRow?.signCount ?? (storedCred!.signCount as number)
      const sigCountSupported = pkRow?.signCountSupported ?? (storedCred!.signCountSupported as boolean)
      const newSignCount = authenticationInfo.newCounter

      if (newSignCount > 0) {
        if (sigCountSupported && newSignCount <= currentSignCount) {
          // Replay detected — freeze credential
          await conn.execute(
            `UPDATE passkeys SET status = 'frozen', frozenReason = 'signcount_replay' WHERE id = ?`,
            [storedCred!.id],
          )
          await conn.commit()
          sendError(res, 'PASSKEY_REPLAY_DETECTED', '凭证回放检测，已冻结', req.requestId, 422)
          return
        }
        // Update signCount atomically
        await conn.execute(`UPDATE passkeys SET signCount = ? WHERE id = ?`, [newSignCount, storedCred!.id])
      }

      // Mark challenge as used within same transaction
      await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL`, [Date.now(), record.id])

      await conn.commit()
    } catch (err) {
      await conn.rollback().catch(() => {})
      console.error('passkey signcount update error:', err)
      sendError(res, Errors.INTERNAL_ERROR.code, '登录失败', req.requestId, 500)
      return
    } finally {
      conn.release()
    }
  }

  // Create session
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'

  // Load user data for JWT
  const userRow = await queryOne(
    `SELECT id, username, displayName, avatarUrl, emailVerified, tokenVersion FROM users WHERE id = ?`,
    [passkeyUserId],
  ) as Record<string, unknown> | null

  if (!userRow) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500)
    return
  }

  // Fetch roles from user_roles table (api.md §15.10)
  let roles: string[] = []
  try {
    const roleRows = await query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
      [passkeyUserId],
    )
    roles = (roleRows as Array<{ name: string }>).map(r => r.name)
  } catch { /* no roles */ }

  const { sessionId, refreshToken } = await createSession(passkeyUserId, roles, 'passkey', ip, ua)

  // Update lastUsedAt
  await exec(`UPDATE passkeys SET lastUsedAt = ? WHERE id = ?`, [Date.now(), storedCred!.id as string])

  const accessToken = await signJwt({
    sub: storedCred!.userId,
    sid: sessionId,
    tokenVersion: userRow.tokenVersion as number,
    roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: true,
    sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
  })

  // api.md §1.3: 浏览器场景通过 Cookie 下发时，响应体省略 refreshToken
  const nativeClient = isNativeClient(req)
  const pkResp: Record<string, unknown> = {
    mfaRequired: false,
    accessToken, tokenType: 'Bearer', expiresIn: 900,
    user: {
      id: userRow.id, username: userRow.username,
      displayName: userRow.displayName, avatarUrl: userRow.avatarUrl || null,
      emailVerified: !!userRow.emailVerified,
    },
  }
  if (nativeClient) pkResp.refreshToken = refreshToken
  sendSuccess(res, pkResp, req.requestId)
})

export default router
