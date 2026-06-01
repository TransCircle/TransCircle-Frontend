import { Router, type Router as RouterType } from 'express';
import { conf } from '../Config';
import { exec, queryOne } from '../Database';
import { ulid } from '../utils/ulid';
import { signJwt } from '../utils/jwt';
import { sendSuccess, sendError, Errors } from '../utils/response';
import {
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeUserSessions,
} from '../utils/session';
import { findUserById, findOrCreateOAuthUser, setUserAdmin } from '../utils/users';
import { loginCodeSchema, completeRegistrationSchema } from '../utils/validation';
import { rateLimitCheck } from '../middleware/rateLimit';

const router: RouterType = Router();

const oauthConf = conf.OAUTH as Record<string, string | undefined> | undefined;
const GITHUB_CLIENT_ID = oauthConf?.GITHUB_CLIENT_ID as string | undefined;
const GITHUB_CLIENT_SECRET = oauthConf?.GITHUB_CLIENT_SECRET as string | undefined;
const X_CLIENT_ID = oauthConf?.X_CLIENT_ID as string | undefined;
const X_CLIENT_SECRET = oauthConf?.X_CLIENT_SECRET as string | undefined;

const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined;
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

// ──────────────────────────────────────────────
// POST /auth/refresh
// Refresh access token using HttpOnly refresh cookie
// ──────────────────────────────────────────────
router.post('/refresh', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const rawToken = req.cookies?.refresh_token;
  if (!rawToken) {
    sendError(res, Errors.UNAUTHORIZED.code, '未找到刷新令牌', req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  const sessionInfo = await rotateRefreshToken(rawToken, ip, ua);
  if (!sessionInfo) {
    sendError(res, Errors.UNAUTHORIZED.code, '刷新令牌无效或已过期', req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  // Issue new refresh token and set cookie
  // (rotateRefreshToken doesn't return the new raw token, so we issue one here)
  const { sessionId, refreshToken } = await createSession(
    sessionInfo.userId,
    sessionInfo.isAdmin,
    'refresh',
    ip,
    ua,
    sessionInfo.tokenVersion,
  );

  // Revoke the old session
  await revokeSession(sessionInfo.id, 'logout');

  const accessToken = await signJwt({
    sub: sessionInfo.userId,
    sessionId,
    tokenVersion: sessionInfo.tokenVersion,
    isAdmin: sessionInfo.isAdmin,
  });

  // Set refresh token as HttpOnly cookie
  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 86400;
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAge * 1000,
  });

  sendSuccess(res, { accessToken }, req.requestId);
});

// ──────────────────────────────────────────────
// POST /auth/logout
// Logout: revoke session, clear cookie
// ──────────────────────────────────────────────
router.post('/logout', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const rawToken = req.cookies?.refresh_token;

  if (rawToken) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    const sessionInfo = await rotateRefreshToken(rawToken, ip, ua);
    if (sessionInfo) {
      await revokeUserSessions(sessionInfo.userId, 'logout', sessionInfo.id);
      await revokeSession(sessionInfo.id, 'logout');
    }
  }

  res.clearCookie('refresh_token', { path: '/' });
  sendSuccess(res, { message: '已退出登录' }, req.requestId);
});

// ──────────────────────────────────────────────
// GET /auth/oauth/github/start
// Start GitHub OAuth login flow
// ──────────────────────────────────────────────
router.get('/oauth/github/start', async (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    sendError(res, 'OAUTH_NOT_CONFIGURED', 'GitHub OAuth 未配置', req.requestId, 503);
    return;
  }

  const state = ulid();
  const callbackUrl = `${APP_URL}/v1/auth/oauth/github/callback`;

  // Store state in auth_tokens for verification (with IP/UA binding)
  const stateHash = await simpleHash(state);
  const stateIp = req.ip || req.socket.remoteAddress || 'unknown';
  const stateUa = req.headers['user-agent'] || 'unknown';
  const stateMeta = JSON.stringify({
    ipHash: await simpleHash(stateIp),
    uaHash: await simpleHash(stateUa),
  });
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), stateHash, stateMeta, Date.now() + 600_000, Date.now()], // 10 min expiry
  );

  // Set state as cookie for CSRF protection
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600_000,
  });

  const authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=read:user+user:email&state=${state}`;

  sendSuccess(res, { authorizationUrl }, req.requestId);
});

// ──────────────────────────────────────────────
// GET /auth/oauth/github/callback
// GitHub OAuth callback
// ──────────────────────────────────────────────
router.get('/oauth/github/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
    return;
  }

  // Verify state (CSRF: cookie must match URL param)
  const cookieState = req.cookies?.oauth_state;
  if (cookieState !== state) {
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  // Verify state record exists in DB with IP/UA binding
  const stateHash = await simpleHash(state);
  const stateRecord = await queryOne<any[]>(
    `SELECT id, metadata FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_state' AND expiresAt > ?`,
    [stateHash, Date.now()],
  );
  if (!stateRecord) {
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  const meta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata;
  const cbIp = req.ip || req.socket.remoteAddress || 'unknown';
  const cbUa = req.headers['user-agent'] || 'unknown';
  if ((meta.ipHash && meta.ipHash !== await simpleHash(cbIp)) ||
      (meta.uaHash && meta.uaHash !== await simpleHash(cbUa))) {
    await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id]);
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  // State verified — clean up consumed record
  await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id]);
  res.clearCookie('oauth_state', { path: '/' });

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
      return;
    }

    // Fetch user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'TransCircle',
      },
    });
    const githubUser = await userRes.json() as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
      email: string | null;
    };

    // Fetch emails if needed
    let email = githubUser.email;
    if (!email) {
      try {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'TransCircle',
            Accept: 'application/vnd.github.v3+json',
          },
        });
        const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified);
        if (primary) email = primary.email;
      } catch { /* ignore */ }
    }

    const providerUserId = String(githubUser.id);
    const { user: userRecord, isNew } = await findOrCreateOAuthUser(
      'github',
      providerUserId,
      githubUser.login,
      githubUser.name || githubUser.login,
      githubUser.avatar_url,
      email || null,
    );

    if (isNew) {
      // Check GitHub org membership for admin
      try {
        const orgRes = await fetch(`https://api.github.com/orgs/TransCircle/members/${githubUser.login}`, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'TransCircle',
          },
        });
        if (orgRes.status === 204) {
          await setUserAdmin(userRecord.id, userRecord.id, true);
        }
      } catch { /* org check failed */ }

      // Generate login code for new user
      const loginCode = ulid();
      const loginCodeHash = await simpleHash(loginCode);
      const csrfToken = ulid();

      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
        [ulid(), userRecord.id, loginCodeHash, Date.now() + 600_000, Date.now()],
      );

      // Store CSRF token
      const csrfHash = await simpleHash(csrfToken);
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_pending_registration', ?, JSON_OBJECT('loginCode', ?), ?, ?)`,
        [ulid(), userRecord.id, csrfHash, loginCode, Date.now() + 600_000, Date.now()],
      );

      res.cookie('oauth_pending_csrf', csrfToken, {
        httpOnly: false, // readable by frontend JS for X-CSRF-Token header
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600_000,
      });

      res.redirect(
        `${APP_URL}/auth/callback?status=pending_registration&loginCode=${loginCode}&provider=github`,
      );
    } else {
      // Returning user — generate login code and redirect
      const loginCode = ulid();
      const loginCodeHash = await simpleHash(loginCode);
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
        [ulid(), userRecord.id, loginCodeHash, Date.now() + 600_000, Date.now()],
      );

      res.redirect(
        `${APP_URL}/auth/callback?status=login_ok&loginCode=${loginCode}&provider=github`,
      );
    }
  } catch (err) {
    console.error('GitHub OAuth error:', err);
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
  }
});

// ──────────────────────────────────────────────
// GET /auth/oauth/x/start
// Start X (Twitter) OAuth 2.0 login flow
// ──────────────────────────────────────────────
router.get('/oauth/x/start', async (req, res) => {
  if (!X_CLIENT_ID) {
    sendError(res, 'OAUTH_NOT_CONFIGURED', 'X OAuth 未配置', req.requestId, 503);
    return;
  }

  const state = ulid();
  const codeVerifier = ulid() + ulid();
  const callbackUrl = `${APP_URL}/v1/auth/oauth/x/callback`;

  // Store state and code verifier (with IP/UA binding)
  const stateHash = await simpleHash(state);
  const xStateIp = req.ip || req.socket.remoteAddress || 'unknown';
  const xStateUa = req.headers['user-agent'] || 'unknown';
  const xStateMeta = JSON.stringify({
    codeVerifier,
    ipHash: await simpleHash(xStateIp),
    uaHash: await simpleHash(xStateUa),
  });
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), stateHash, xStateMeta, Date.now() + 600_000, Date.now()],
  );

  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600_000,
  });

  const scopes = encodeURIComponent('tweet.read users.read');
  const authorizationUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${X_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${scopes}&state=${state}&code_challenge=${codeVerifier}&code_challenge_method=plain`;

  sendSuccess(res, { authorizationUrl }, req.requestId);
});

// ──────────────────────────────────────────────
// GET /auth/oauth/x/callback
// X (Twitter) OAuth callback
// ──────────────────────────────────────────────
router.get('/oauth/x/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
    return;
  }

  const cookieState = req.cookies?.oauth_state;
  if (cookieState !== state) {
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  // Retrieve stored state record from DB
  const stateHash = await simpleHash(state);
  const stateRecord = await queryOne<any[]>(
    `SELECT id, metadata FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_state' AND expiresAt > ?`,
    [stateHash, Date.now()],
  );
  if (!stateRecord) {
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  const meta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata;
  const codeVerifier = meta.codeVerifier;
  if (!codeVerifier) {
    await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id]);
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
    return;
  }

  // Verify IP/UA binding
  const xCbIp = req.ip || req.socket.remoteAddress || 'unknown';
  const xCbUa = req.headers['user-agent'] || 'unknown';
  if ((meta.ipHash && meta.ipHash !== await simpleHash(xCbIp)) ||
      (meta.uaHash && meta.uaHash !== await simpleHash(xCbUa))) {
    await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id]);
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`);
    return;
  }

  // State verified — clean up consumed record
  await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id]);
  res.clearCookie('oauth_state', { path: '/' });

  try {
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${APP_URL}/v1/auth/oauth/x/callback`,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
      return;
    }

    // Fetch user info
    const userRes = await fetch('https://api.twitter.com/2/users/me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });
    const userData = await userRes.json() as {
      data?: { id: string; username: string; name: string };
    };

    if (!userData.data) {
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
      return;
    }

    const { id, username, name } = userData.data;
    const { user: userRecord, isNew } = await findOrCreateOAuthUser(
      'x',
      id,
      username,
      name || username,
      null,
      null,
    );

    if (isNew) {
      // Generate login code for new user
      const loginCode = ulid();
      const loginCodeHash = await simpleHash(loginCode);
      const csrfToken = ulid();

      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
        [ulid(), userRecord.id, loginCodeHash, Date.now() + 600_000, Date.now()],
      );

      // Store CSRF token
      const csrfHash = await simpleHash(csrfToken);
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_pending_registration', ?, JSON_OBJECT('loginCode', ?), ?, ?)`,
        [ulid(), userRecord.id, csrfHash, loginCode, Date.now() + 600_000, Date.now()],
      );

      res.cookie('oauth_pending_csrf', csrfToken, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600_000,
      });

      res.redirect(
        `${APP_URL}/auth/callback?status=pending_registration&loginCode=${loginCode}&provider=x`,
      );
    } else {
      // Returning user — generate login code and redirect
      const loginCode = ulid();
      const loginCodeHash = await simpleHash(loginCode);
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
        [ulid(), userRecord.id, loginCodeHash, Date.now() + 600_000, Date.now()],
      );

      res.redirect(
        `${APP_URL}/auth/callback?status=login_ok&loginCode=${loginCode}&provider=x`,
      );
    }
  } catch (err) {
    console.error('X OAuth error:', err);
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`);
  }
});

// ──────────────────────────────────────────────
// POST /auth/oauth/complete-registration
// Complete OAuth registration with username/password etc.
// ──────────────────────────────────────────────
router.post('/oauth/complete-registration', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const provider = req.query.provider as string || 'github';

  const csrfToken = req.headers['x-csrf-token'] as string | undefined;
  if (!csrfToken) {
    sendError(res, Errors.VALIDATION_ERROR.code, '缺少 CSRF Token', req.requestId, 400);
    return;
  }

  const parsed = completeRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 400, parsed.error.flatten());
    return;
  }

  const { username, email, password, displayName } = parsed.data;

  // Verify CSRF token
  const csrfHash = await simpleHash(csrfToken);
  const csrfRecord = await queryOne<any[]>(
    `SELECT userId, metadata FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND (expiresAt > ? OR expiresAt IS NULL)`,
    [csrfHash, Date.now()],
  );

  if (!csrfRecord) {
    sendError(res, Errors.GONE.code, 'CSRF Token 无效或已过期', req.requestId, 410);
    return;
  }

  const userId = csrfRecord.userId;

  // Check username uniqueness
  const existing = await queryOne<any[]>(
    `SELECT id FROM users WHERE username = ? AND id != ?`,
    [username, userId],
  );

  if (existing) {
    sendError(res, Errors.CONFLICT.code, '用户名已被使用', req.requestId, 409);
    return;
  }

  // Hash password and update user
  const pbkdf2Key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    pbkdf2Key,
    512,
  );

  const passwordHash = btoa(String.fromCharCode(...new Uint8Array(salt))) +
    ':' +
    btoa(String.fromCharCode(...new Uint8Array(derivedBits)));

  const now = Date.now();

  await exec(
    `UPDATE users SET username = ?, email = ?, displayName = COALESCE(NULLIF(?, ''), displayName), passwordHash = ?, passwordUpdatedAt = ?, status = 'active', updatedAt = ? WHERE id = ?`,
    [username, email || null, displayName || '', passwordHash, now, now, userId],
  );

  // Delete CSRF token
  await exec(
    `DELETE FROM auth_tokens WHERE id = ?`,
    [csrfRecord.id],
  );

  // Generate login code for the response
  const loginCode = ulid();
  const loginCodeHash = await simpleHash(loginCode);
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
    [ulid(), userId, loginCodeHash, now + 600_000, now],
  );

  const user = await findUserById(userId);
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500);
    return;
  }

  res.clearCookie('oauth_pending_csrf', { path: '/' });

  sendSuccess(res, {
    loginCode,
    user: {
      provider: provider as 'github' | 'x',
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      displayName: user.displayName,
    },
  }, req.requestId);
});

// Helper: simple SHA-256 hash
async function simpleHash(data: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Re-export exchange endpoint with proper atomic implementation
// To avoid the previous bug, redo exchange properly
router.post('/oauth/exchange', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = loginCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'loginCode 不能为空', req.requestId, 400);
    return;
  }

  const { loginCode } = parsed.data;
  const loginCodeHash = await simpleHash(loginCode);

  // Atomic: SELECT the token row first
  const token = await queryOne<any[]>(
    `SELECT id, userId, expiresAt FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_login_code'`,
    [loginCodeHash],
  );

  if (!token) {
    sendError(res, Errors.GONE.code, 'loginCode 无效', req.requestId, 410);
    return;
  }

  if (token.expiresAt < Date.now()) {
    await exec(`DELETE FROM auth_tokens WHERE id = ?`, [token.id]);
    sendError(res, Errors.GONE.code, 'loginCode 已过期', req.requestId, 410);
    return;
  }

  // Atomic: DELETE with the specific ID (prevents race)
  const deleteResult = await exec(
    `DELETE FROM auth_tokens WHERE id = ? AND tokenHash = ?`,
    [token.id, loginCodeHash],
  );

  if (deleteResult.affectedRows === 0) {
    sendError(res, Errors.GONE.code, 'loginCode 已被使用', req.requestId, 410);
    return;
  }

  // Get user
  const user = await findUserById(token.userId);
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500);
    return;
  }

  // Get the actual OAuth provider
  const exchangeOauth = await queryOne<any[]>(
    `SELECT provider FROM oauth_accounts WHERE userId = ? LIMIT 1`,
    [token.userId],
  );
  const exchangeProvider = (exchangeOauth?.provider as 'github' | 'x') || 'github';

  // We already have the refresh token and access token from the OAuth callback,
  // but for exchange path the tokens may not have been issued yet.
  // Check if there's an active session
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  const { sessionId, refreshToken } = await createSession(
    user.id,
    user.isAdmin,
    'oauth:exchange',
    ip,
    ua,
    user.tokenVersion,
  );

  const accessToken = await signJwt({
    sub: user.id,
    sessionId,
    tokenVersion: user.tokenVersion,
    isAdmin: user.isAdmin,
  });

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 86400;
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAge * 1000,
  });

  sendSuccess(res, {
    accessToken,
    user: {
      provider: exchangeProvider,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      displayName: user.displayName,
    },
  }, req.requestId);
});

export default router;
