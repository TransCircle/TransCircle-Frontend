import { query, queryOne, exec } from '../Database';
import { ulid } from './ulid';

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  tokenVersion: number;
  status: string;
  createdAt: number;
  lastLoginAt: number | null;
  isAdmin: boolean;
}

export interface OAuthAccountRecord {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  providerUsername: string | null;
  providerDisplayName: string | null;
  providerAvatarUrl: string | null;
}

/**
 * Find a user by OAuth provider + providerUserId.
 */
export async function findUserByOAuth(
  provider: string,
  providerUserId: string,
): Promise<UserRecord | null> {
  const oauth = await queryOne<any[]>(
    `SELECT userId FROM oauth_accounts WHERE provider = ? AND providerUserId = ?`,
    [provider, providerUserId],
  );
  if (!oauth) return null;

  return findUserById(oauth.userId);
}

/**
 * Find a user by ID.
 */
export async function findUserById(id: string): Promise<UserRecord | null> {
  const user = await queryOne<any[]>(
    `SELECT u.*, EXISTS(
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.roleId
       WHERE ur.userId = u.id AND r.name = 'admin' AND (ur.expiresAt IS NULL OR ur.expiresAt > UNIX_TIMESTAMP(NOW()) * 1000)
     ) as isAdmin
     FROM users u WHERE u.id = ?`,
    [id],
  );
  return user || null;
}

/**
 * Find a user by username.
 */
export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const user = await queryOne<any[]>(
    `SELECT u.*, EXISTS(
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.roleId
       WHERE ur.userId = u.id AND r.name = 'admin' AND (ur.expiresAt IS NULL OR ur.expiresAt > UNIX_TIMESTAMP(NOW()) * 1000)
     ) as isAdmin
     FROM users u WHERE u.username = ?`,
    [username],
  );
  return user || null;
}

/**
 * Find or create an OAuth user.
 * Returns the existing user if found, or creates a new one.
 */
export async function findOrCreateOAuthUser(
  provider: string,
  providerUserId: string,
  providerUsername: string | null,
  providerDisplayName: string | null,
  providerAvatarUrl: string | null,
  providerEmail: string | null,
): Promise<{ user: UserRecord; isNew: boolean }> {
  // Check if an oauth_account exists for this provider+id
  const existing = await queryOne<any[]>(
    `SELECT oa.userId, u.*, EXISTS(
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.roleId
       WHERE ur.userId = u.id AND r.name = 'admin'
     ) as isAdmin
     FROM oauth_accounts oa
     JOIN users u ON u.id = oa.userId
     WHERE oa.provider = ? AND oa.providerUserId = ?`,
    [provider, providerUserId],
  );

  if (existing) {
    // Update username/avatar
    if (providerUsername || providerDisplayName) {
      await exec(
        `UPDATE oauth_accounts SET providerUsername = ?, providerDisplayName = ?, providerAvatarUrl = ?, updatedAt = ? WHERE provider = ? AND providerUserId = ?`,
        [
          providerUsername || null,
          providerDisplayName || null,
          providerAvatarUrl || null,
          Date.now(),
          provider,
          providerUserId,
        ],
      );
    }
    return { user: existing as UserRecord, isNew: false };
  }

  // Check if we already have an oauth_account with matching email (rare, but possible account merge)
  // Create new user
  const userId = ulid();
  const now = Date.now();
  const displayName = providerDisplayName || providerUsername || `user_${providerUserId.slice(0, 8)}`;
  const username = `user_${ulid().slice(0, 12).toLowerCase()}`;

  await exec(
    `INSERT INTO users (id, username, email, emailVerified, displayName, avatarUrl, status, createdAt, lastLoginAt)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [userId, username, providerEmail || null, !!providerEmail, displayName, providerAvatarUrl || null, now, now],
  );

  // Create oauth_account
  await exec(
    `INSERT INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), userId, provider, providerUserId, providerUsername || null, providerDisplayName || null, providerAvatarUrl || null, providerEmail || null, now, now],
  );

  const user = await findUserById(userId);
  return { user: user!, isNew: true };
}

/**
 * Set user admin status (add/remove admin role).
 */
export async function setUserAdmin(userId: string, grantorUserId: string, isAdmin: boolean): Promise<void> {
  const role = await queryOne<any[]>(
    `SELECT id FROM roles WHERE name = 'admin'`,
  );
  if (!role) {
    // Create admin role if not exists
    const roleId = ulid();
    await exec(
      `INSERT INTO roles (id, name, description, createdAt) VALUES (?, 'admin', '系统管理员', ?)`,
      [roleId, Date.now()],
    );
    if (isAdmin) {
      await exec(
        `INSERT INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
        [ulid(), userId, roleId, grantorUserId, Date.now()],
      );
    }
    return;
  }

  if (isAdmin) {
    await exec(
      `INSERT IGNORE INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
      [ulid(), userId, role.id, grantorUserId, Date.now()],
    );
  } else {
    await exec(
      `DELETE FROM user_roles WHERE userId = ? AND roleId = ?`,
      [userId, role.id],
    );
  }

  // Bump tokenVersion so existing JWTs reflect the new role immediately
  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [userId]);
}

/**
 * Check if GitHub organization member (simplified — checks via GitHub API).
 * Uses the temp admin token if OAuth is not configured.
 */
export async function checkGitHubOrgMembership(
  githubUsername: string,
  githubToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/orgs/TransCircle/members/${githubUsername}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'TransCircle',
      },
    });
    return res.status === 204;
  } catch {
    return false;
  }
}
