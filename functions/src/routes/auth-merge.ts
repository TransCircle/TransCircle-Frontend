import { Router } from 'express'
import { queryOne, getConnection } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { genId } from '../utils/ulid'
import { hmacToken } from '../utils/session'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { canonicalJson, sha256base64url } from '../utils/audit'

const router: Router = Router()

// POST /auth/merge — api.md §1.8
router.post('/auth/merge', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { mergeToken, confirm } = req.body as { mergeToken?: string; confirm?: boolean }

  if (!mergeToken || confirm !== true) {
    sendError(res, Errors.BAD_REQUEST.code, '请求参数错误', req.requestId, 400)
    return
  }

  // Check step-up
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ?`,
    [req.user!.sessionId],
  )
  if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  const tokenHash = await hmacToken(mergeToken)
  const record = await queryOne(
    `SELECT id, userId, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'merge' AND usedAt IS NULL AND expiresAt > ?`,
    [tokenHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '合并令牌无效', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata
  const now = Date.now()

  // Verify the current user is the primary account owner (api.md §1.8 security check)
  const primaryUserId = meta.primaryUserId as string | undefined
  if (!primaryUserId || req.user!.userId !== primaryUserId) {
    sendError(res, Errors.UNAUTHORIZED.code, '仅主账号可发起合并', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  // Count sessions before revoking (outside transaction — informational)
  const conflictSessions = await queryOne(
    `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedAt IS NULL`,
    [meta.conflictUserId],
  )
  const primaryOtherSessions = await queryOne(
    `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND id != ? AND revokedAt IS NULL`,
    [req.user!.userId, req.user!.sessionId],
  )

  // ── Transaction: all merge operations atomically ──
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // Migrate resources per api.md §1.8:
    // - contributions: authorUserId → primary
    await conn.execute(`UPDATE contributions SET authorUserId = ? WHERE authorUserId = ?`, [req.user!.userId, meta.conflictUserId])
    // - edit_requests: requesterId → primary
    await conn.execute(`UPDATE contribution_edit_requests SET requesterId = ? WHERE requesterId = ?`, [req.user!.userId, meta.conflictUserId])
    // - images: uploaderId → primary
    await conn.execute(`UPDATE images SET uploaderId = ? WHERE uploaderId = ?`, [req.user!.userId, meta.conflictUserId])
    // - oauth_accounts: if provider conflict on primary, keep primary's
    await conn.execute(
      `DELETE oa FROM oauth_accounts oa
       INNER JOIN oauth_accounts primary_oa ON primary_oa.userId = ? AND primary_oa.provider = oa.provider
       WHERE oa.userId = ?`,
      [req.user!.userId, meta.conflictUserId],
    )
    await conn.execute(`UPDATE oauth_accounts SET userId = ? WHERE userId = ?`, [req.user!.userId, meta.conflictUserId])

    // Freeze passkeys on merged account
    await conn.execute(`UPDATE passkeys SET status = 'frozen', frozenReason = 'account_merged' WHERE userId = ? AND status = 'active'`, [meta.conflictUserId])

    // Disable MFA TOTP on merged account
    await conn.execute(`UPDATE mfa_totp_credentials SET status = 'disabled' WHERE userId = ?`, [meta.conflictUserId])

    // Disable MFA recovery codes on merged account
    await conn.execute(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE userId = ? AND usedAt IS NULL`, [now, meta.conflictUserId])

    // Mark merged account
    await conn.execute(`UPDATE users SET status = 'merged', mergedIntoUserId = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [req.user!.userId, now, meta.conflictUserId])

    // Revoke all sessions of merged account
    await conn.execute(`UPDATE sessions SET revokedAt = ?, revokedReason = 'account_merged' WHERE userId = ? AND revokedAt IS NULL`, [now, meta.conflictUserId])
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [meta.conflictUserId, now],
    )

    // Mark token as used
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, record.id])

    // Revoke current user's other sessions (keep current)
    await conn.execute(`UPDATE sessions SET revokedAt = ?, revokedReason = 'account_merged' WHERE userId = ? AND id != ? AND revokedAt IS NULL`, [now, req.user!.userId, req.user!.sessionId])
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND id != ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [req.user!.userId, req.user!.sessionId, now],
    )
    await conn.execute(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

    // Audit log inside transaction (api.md §1.8: 操作写入 audit_logs)
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ua = req.headers['user-agent'] || 'unknown'
    const mergeAuditId = genId('aud_')
    const [lastMergeAudit] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT entryHash FROM audit_logs ORDER BY createdAt DESC LIMIT 1 FOR UPDATE`,
    )
    const mergePrevHash = (lastMergeAudit[0]?.entryHash as string) ?? null
    const mergeAfterData = { mergedFromUserId: meta.conflictUserId, provider: meta.provider }
    const mergeCanonicalAfter = canonicalJson(mergeAfterData)
    const mergeRecordData = {
      id: mergeAuditId, actorUserId: req.user!.userId, action: 'account.merge',
      resourceType: 'user', resourceId: req.user!.userId,
      before: null, after: mergeAfterData, metadata: {},
      createdAt: now, requestId: req.requestId,
      ipHash: await hmacToken(ip), uaHash: await hmacToken(ua),
    }
    const mergeCanonicalRecord = canonicalJson(mergeRecordData)
    const mergeChainInput = mergePrevHash ? `${mergePrevHash}|${mergeCanonicalRecord}` : mergeCanonicalRecord
    const mergeEntryHash = await sha256base64url(mergeChainInput)
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'account.merge', 'user', ?, NULL, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [mergeAuditId, req.user!.userId, req.user!.userId,
       mergeCanonicalAfter, now, req.requestId,
       await hmacToken(ip), await hmacToken(ua),
       mergePrevHash, mergeEntryHash],
    )

    await conn.commit()

    const totalRevoked = ((conflictSessions?.cnt as number) || 0) + ((primaryOtherSessions?.cnt as number) || 0)

    sendSuccess(res, {
      merged: true,
      primaryUserId: req.user!.userId,
      mergedFromUserId: meta.conflictUserId,
      revokedSessions: totalRevoked,
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('Merge error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '合并失败，请重试', req.requestId, 500)
  } finally {
    conn.release()
  }
})

export default router
