import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { hmacToken } from '../utils/session'
import { requireAuth } from '../middleware/auth'

const router: Router = Router()

// POST /auth/step-up/start — api.md §1.12.1
router.post('/auth/step-up/start', requireAuth, async (req, res) => {
  if (req.user!.roles.length === 0) {
    // Not admin — still allow step-up for sensitive operations
  }

  const challengeId = ulid()
  const challengeHash = await hmacToken(challengeId)

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'step_up_challenge', ?, '{}', ?, ?)`,
    [ulid(), req.user!.userId, challengeHash, Date.now() + 300_000, Date.now()],
  )

  sendSuccess(res, {
    challengeId,
    expiresIn: 300,
    availableMethods: ['password'],
  }, req.requestId)
})

// POST /auth/step-up/verify — api.md §1.12.2
router.post('/auth/step-up/verify', requireAuth, async (req, res) => {
  const { challengeId, method, password } = req.body as {
    challengeId?: string; method?: string; password?: string
  }

  if (!challengeId || !method) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const challengeHash = await hmacToken(challengeId)
  const record = await queryOne(
    `SELECT id, userId FROM auth_tokens WHERE tokenHash = ? AND type = 'step_up_challenge' AND usedAt IS NULL AND expiresAt > ?`,
    [challengeHash, Date.now()],
  )

  if (!record || record.userId !== req.user!.userId) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '挑战令牌无效', req.requestId, 410)
    return
  }

  if (method === 'password') {
    if (!password) {
      sendError(res, Errors.BAD_REQUEST.code, '密码不能为空', req.requestId, 400)
      return
    }

    const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [req.user!.userId])
    if (!userRow?.passwordHash) {
      sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }

    const { verifyPassword } = await import('../utils/password')
    const valid = await verifyPassword(userRow.passwordHash as string, password)
    if (!valid) {
      sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }
  } else {
    sendError(res, Errors.BAD_REQUEST.code, '不支持的验证方法', req.requestId, 400)
    return
  }

  // Mark challenge as used
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])

  // Update session lastStepUpAt
  await exec(
    `UPDATE sessions SET lastStepUpAt = ?, lastStepUpMethod = ? WHERE id = ?`,
    [Date.now(), method, req.user!.sessionId],
  )

  sendSuccess(res, {
    stepUpAt: Date.now(),
    method,
    validForSeconds: 300,
  }, req.requestId)
})

export default router
