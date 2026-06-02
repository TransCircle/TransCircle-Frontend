import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { hmacToken, revokeUserSessions } from '../utils/session'
import { requireAuth } from '../middleware/auth'

const router: Router = Router()

// POST /auth/merge — api.md §1.8
router.post('/auth/merge', requireAuth, async (req, res) => {
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
    `SELECT id, userId, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'account_merge' AND usedAt IS NULL AND expiresAt > ?`,
    [tokenHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '合并令牌无效', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata
  const now = Date.now()

  // Mark merged account
  await exec(`UPDATE users SET status = 'merged', mergedIntoUserId = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [req.user!.userId, now, meta.conflictUserId])
  await revokeUserSessions(meta.conflictUserId, 'account_merged')

  // Mark token as used
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, record.id])

  // Revoke current user's other sessions
  await revokeUserSessions(req.user!.userId, 'account_merged', req.user!.sessionId)
  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

  sendSuccess(res, {
    merged: true,
    primaryUserId: req.user!.userId,
    mergedFromUserId: meta.conflictUserId,
    revokedSessions: 0,
  }, req.requestId)
})

export default router
