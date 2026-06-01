import { Router, type Router as RouterType } from 'express';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { queryOne } from '../Database';
import { requireAuth } from '../middleware/auth';
import { findUserById } from '../utils/users';

const router: RouterType = Router();

// ──────────────────────────────────────────────
// GET /me
// Get current user info
// ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const user = await findUserById(req.user!.userId);
  if (!user) {
    sendError(res, Errors.NOT_FOUND.code, '用户不存在', req.requestId, 404);
    return;
  }

  // Get the actual OAuth provider from oauth_accounts
  const oauth = await queryOne<any[]>(
    `SELECT provider FROM oauth_accounts WHERE userId = ? LIMIT 1`,
    [req.user!.userId],
  );

  sendSuccess(res, {
    user: {
      provider: (oauth?.provider as 'github' | 'x') || 'github',
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
    },
  }, req.requestId);
});

export default router;
