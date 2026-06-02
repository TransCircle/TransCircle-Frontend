import { Router, type Router as RouterType } from 'express'
import { sendError, Errors } from '../utils/response'
import { queryOne } from '../Database'
import { requireAuth } from '../middleware/auth'
import { findUserById } from '../utils/users'

const router: RouterType = Router()

// ──────────────────────────────────────────────
// GET /me — api.md §2.1 获取当前用户资料
// ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const user = await findUserById(req.user!.userId)
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  // Get OAuth providers bound to this account
  const oauthAccounts = await queryOne(
    `SELECT GROUP_CONCAT(provider) as providers FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  )

  // Check if user has a password set
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [req.user!.userId])
  const hasPassword = !!(userRow as Record<string, unknown> | null)?.passwordHash

  // Count active passkeys
  const passkeyRow = await queryOne(
    `SELECT COUNT(*) as count FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )
  const passkeyCount = (passkeyRow?.count as number) || 0

  // Check TOTP status
  const totpRow = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [req.user!.userId],
  )

  const oauthProviders = oauthAccounts?.providers
    ? (oauthAccounts.providers as string).split(',')
    : []

  // Send response per api.md §2.1 format
  ;(await import('../utils/response')).sendSuccess(
    res,
    {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      status: user.status,
      roles: user.roles,
      security: {
        hasPassword,
        totpEnabled: !!totpRow,
        passkeyCount,
        oauthProviders,
      },
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    req.requestId,
  )
})

export default router
