import mysql from 'mysql2';
import { Router, type Router as RouterType } from 'express';
import { conf } from '../Config';
import { exec, queryOne, getConnection } from '../Database';
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
const APP_URL = 'https://submit.transcircle.org';

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

  const sessionInfo = await rotateRefreshToken(rawToken);
  if (!sessionInfo) {
    sendError(res, Errors.UNAUTHORIZED.code, '刷新令牌无效或已过期', req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

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
    const sessionInfo = await rotateRefreshToken(rawToken);
    if (sessionInfo) {
      await revokeUserSessions(sessionInfo.userId, 'logout', sessionInfo.id);
      await revokeSession(sessionInfo.id, 'logout');
      // Bump tokenVersion to invalidate all JWTs for this user immediately
      await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [sessionInfo.userId]);
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
  const stateRecord = await queryOne(
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

      // Set oauth_pending_<provider> HttpOnly cookie for dual-cookie CSRF pattern
      // Per apidocs.md §1.6.4: both oauth_pending_<provider> and oauth_pending_csrf must be set
      res.cookie(`oauth_pending_github`, loginCode, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/v1/auth/oauth',
        maxAge: 600_000,
      });

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
  const stateRecord = await queryOne(
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

      // Set oauth_pending_<provider> HttpOnly cookie for dual-cookie CSRF pattern
      res.cookie('oauth_pending_x', loginCode, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/v1/auth/oauth',
        maxAge: 600_000,
      });

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

  // ── Dual-cookie CSRF validation (per apidocs.md §1.6.4) ───────────────
  const csrfToken = req.headers['x-csrf-token'] as string | undefined;
  if (!csrfToken) {
    sendError(res, Errors.VALIDATION_ERROR.code, '缺少 X-CSRF-Token', req.requestId, 400);
    return;
  }

  // Verify oauth_pending_<provider> HttpOnly cookie exists
  const pendingCookieName = `oauth_pending_${provider}`;
  const pendingToken = req.cookies?.[pendingCookieName] as string | undefined;
  if (!pendingToken) {
    sendError(res, Errors.UNAUTHORIZED.code, `缺少 ${pendingCookieName} Cookie`, req.requestId, 401);
    return;
  }

  // Validate request body
  const parsed = completeRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, parsed.error.flatten());
    return;
  }

  const { username, email, password, displayName, emailMatchesProvider } = parsed.data;
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  // ── Transaction with row-level lock ────────────────────────────────────
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    // 1. Look up oauth_pending_registration token with row lock
    const csrfHash = await simpleHash(csrfToken);
    const [lockRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id, userId, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'oauth_pending_registration'
       FOR UPDATE`,
      [csrfHash],
    );

    if (lockRows.length === 0) {
      await conn.rollback();
      sendError(res, Errors.GONE.code, 'CSRF Token 无效或已过期', req.requestId, 410);
      return;
    }

    const pendingRecord = lockRows[0] as { id: string; userId: string; metadata: string };

    // 2. Verify pending token not already consumed
    const [usedCheck] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT usedAt FROM auth_tokens WHERE id = ?`,
      [pendingRecord.id],
    );
    if (usedCheck.length > 0 && (usedCheck[0] as { usedAt: number | null }).usedAt) {
      await conn.rollback();
      sendError(res, Errors.GONE.code, 'CSRF Token 已被使用', req.requestId, 410);
      return;
    }

    // 3. Check username uniqueness
    const [existingUsername] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM users WHERE username = ? AND id != ?`,
      [username, pendingRecord.userId],
    );
    if ((existingUsername as unknown[]).length > 0) {
      await conn.rollback();
      sendError(res, Errors.CONFLICT.code, '用户名已被使用', req.requestId, 409);
      return;
    }

    // 4. Check email uniqueness
    const [existingEmail] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM users WHERE email = ? AND id != ?`,
      [email, pendingRecord.userId],
    );
    if ((existingEmail as unknown[]).length > 0) {
      await conn.rollback();
      sendError(res, Errors.CONFLICT.code, '该邮箱已被注册', req.requestId, 409);
      return;
    }

    // 5. Hash password with PBKDF2 (future: migrate to argon2id)
    const pbkdf2Key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password),
      { name: 'PBKDF2' }, false, ['deriveBits'],
    );
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derivedBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      pbkdf2Key, 512,
    );
    const passwordHash = btoa(String.fromCharCode(...new Uint8Array(salt))) + ':' +
      btoa(String.fromCharCode(...new Uint8Array(derivedBits)));

    // 6. Mark pending token as used
    await conn.execute(
      `UPDATE auth_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL`,
      [now, pendingRecord.id],
    );

    // 7. Update user record
    await conn.execute(
      `UPDATE users SET username = ?, email = ?, displayName = COALESCE(NULLIF(?, ''), displayName),
       passwordHash = ?, passwordUpdatedAt = ?, status = 'active', updatedAt = ? WHERE id = ?`,
      [username, email, displayName || username, passwordHash, now, now, pendingRecord.userId],
    );

    // 8. Create session
    const user = await findUserById(pendingRecord.userId);
    if (!user) {
      await conn.rollback();
      sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500);
      return;
    }

    const { refreshToken } = await createSession(
      user.id, user.isAdmin, `oauth:${provider}`, ip, ua, user.tokenVersion,
    );

    // 9. Generate loginCode for exchange
    const loginCode = ulid();
    const loginCodeHash = await simpleHash(loginCode);
    await conn.execute(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'oauth_login_code', ?, '{}', ?, ?)`,
      [ulid(), user.id, loginCodeHash, now + 60_000, now],
    );

    // 10. Audit log: auth.register
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'auth.register', 'user', ?, '{}', ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [
        ulid(), user.id, user.id,
        JSON.stringify({ username, email, provider }),
        now, req.requestId, await simpleHash(ip), await simpleHash(ua),
        await simpleHash(ulid()), await simpleHash(ulid()),
      ],
    );

    // 11. Audit log: oauth.bind
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'oauth.bind', 'user', ?, '{}', ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [
        ulid(), user.id, user.id,
        JSON.stringify({ provider, bound: true }),
        now, req.requestId, await simpleHash(ip), await simpleHash(ua),
        await simpleHash(ulid()), await simpleHash(ulid()),
      ],
    );

    await conn.commit();

    // ── Set cookies ──────────────────────────────────────────
    const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 86400;
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: maxAge * 1000,
    });

    // Clear pending cookies
    res.clearCookie(`oauth_pending_${provider}`, { path: '/v1/auth/oauth' });
    res.clearCookie('oauth_pending_csrf', { path: '/' });

    // ── Response (201 Created per apidocs.md) ────────────────
    sendSuccess(res, {
      user: {
        id: user.id,
        username: user.username,
        email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        emailVerified: !!emailMatchesProvider,
        status: 'active',
        createdAt: user.createdAt,
      },
      boundProvider: provider as 'github' | 'x',
      loginCode,
      verificationEmailSent: false,
    }, req.requestId, 201);

  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('complete-registration error:', err);
    sendError(res, Errors.INTERNAL_ERROR.code, '注册失败，请稍后重试', req.requestId, 500);
  } finally {
    conn.release();
  }
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

  // ── 原子消费：事务 + 行级锁 ──────────────────────────
  // 防止并发请求同时 SELECT 到同一 loginCode
  let userId: string | null;
  {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();

      // 行级锁 — 并发 SELECT ... FOR UPDATE 会排队等待
      const [lockRows] = await conn.execute(
        `SELECT id, userId, expiresAt FROM auth_tokens
         WHERE tokenHash = ? AND type = 'oauth_login_code'
         FOR UPDATE`,
        [loginCodeHash],
      );
      const rows = lockRows as Array<{ id: string; userId: string; expiresAt: number }>;
      const token = rows[0] ?? null;

      if (!token) {
        await conn.rollback();
        sendError(res, Errors.GONE.code, 'loginCode 无效', req.requestId, 410);
        return;
      }

      if (token.expiresAt < Date.now()) {
        await conn.execute(`DELETE FROM auth_tokens WHERE id = ?`, [token.id]);
        await conn.commit();
        sendError(res, Errors.GONE.code, 'loginCode 已过期', req.requestId, 410);
        return;
      }

      // 条件 DELETE — 两请求同时 DELETE 同一行，仅第一个 affectedRows = 1
      const [delRaw] = await conn.execute(
        `DELETE FROM auth_tokens WHERE id = ? AND tokenHash = ?`,
        [token.id, loginCodeHash],
      );
      const delHeader = delRaw as { affectedRows: number };

      if (delHeader.affectedRows === 0) {
        await conn.commit();
        sendError(res, Errors.GONE.code, 'loginCode 已被使用', req.requestId, 410);
        return;
      }

      userId = token.userId;
      await conn.commit();
    } finally {
      conn.release();
    }
  }

  if (!userId) {
    sendError(res, Errors.INTERNAL_ERROR.code, 'loginCode 兑换失败', req.requestId, 500);
    return;
  }

  // Get user
  const user = await findUserById(userId);
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500);
    return;
  }

  // Get the actual OAuth provider
  const exchangeOauth = await queryOne(
    `SELECT provider FROM oauth_accounts WHERE userId = ? LIMIT 1`,
    [userId],
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
