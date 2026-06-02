import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth } from '../middleware/auth'

const router: Router = Router()

// GET /me/oauth — api.md §1.7.3
router.get('/me/oauth', requireAuth, async (req, res) => {
  const accounts = await exec(
    `SELECT provider, providerUsername, providerDisplayName, providerAvatarUrl, createdAt as boundAt
     FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  ) as unknown as Array<Record<string, unknown>>

  sendSuccess(res, accounts.map((a) => ({
    provider: a.provider,
    providerUsername: a.providerUsername || null,
    providerDisplayName: a.providerDisplayName || null,
    providerAvatarUrl: a.providerAvatarUrl || null,
    boundAt: a.boundAt,
  })), req.requestId)
})

// DELETE /me/oauth/{provider} — api.md §1.7.2
router.delete('/me/oauth/:provider', requireAuth, async (req, res) => {
  const { provider } = req.params

  if (provider !== 'github' && provider !== 'x') {
    sendError(res, Errors.BAD_REQUEST.code, '无效的 provider', req.requestId, 400)
    return
  }

  // Check step-up (5 min)
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ?`,
    [req.user!.sessionId],
  )
  if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  const oauth = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
    [req.user!.userId, provider],
  )
  if (!oauth) {
    sendError(res, 'OAUTH_NOT_BOUND', '该 provider 未绑定', req.requestId, 404)
    return
  }

  // Check there are other login methods
  const otherProviders = await queryOne(
    `SELECT COUNT(*) as cnt FROM oauth_accounts WHERE userId = ? AND provider != ?`,
    [req.user!.userId, provider],
  )
  const hasPassword = await queryOne(
    `SELECT passwordHash FROM users WHERE id = ? AND passwordHash IS NOT NULL`,
    [req.user!.userId],
  )
  const hasPasskey = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )

  if (!hasPassword && !hasPasskey && (otherProviders?.cnt as number || 0) === 0) {
    sendError(res, 'LAST_LOGIN_METHOD', '解绑后将无登录方式', req.requestId, 409)
    return
  }

  await exec(`DELETE FROM oauth_accounts WHERE userId = ? AND provider = ?`, [req.user!.userId, provider])
  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

  sendSuccess(res, {
    provider,
    unbound: true,
    revokedSessions: 0,
  }, req.requestId)
})

export default router
