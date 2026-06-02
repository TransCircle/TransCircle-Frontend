import { queryOne, exec } from '../Database'
import { ulid } from './ulid'

export interface UserRecord {
  id: string
  username: string
  email: string | null
  emailVerified: boolean
  displayName: string
  avatarUrl: string | null
  tokenVersion: number
  status: string
  createdAt: number
  lastLoginAt: number | null
  roles: string[]
}

export interface OAuthAccountRecord {
  id: string
  userId: string
  provider: string
  providerUserId: string
  providerUsername: string | null
  providerDisplayName: string | null
  providerAvatarUrl: string | null
}

/** Build roles list from subquery result. */
function parseRoles(row: Record<string, unknown> | null): string[] {
  if (!row) return []
  const isAdmin = !!(row.isAdmin as number | boolean)
  return isAdmin ? ['reviewer'] : []
}

/** Find a user by OAuth provider + providerUserId. */
export async function findUserByOAuth(provider: string, providerUserId: string): Promise<UserRecord | null> {
  const oauth = await queryOne(`SELECT userId FROM oauth_accounts WHERE provider = ? AND providerUserId = ?`, [
    provider,
    providerUserId,
  ])
  if (!oauth) return null
  return findUserById(oauth.userId)
}

/** Find a user by ID. */
export async function findUserById(id: string): Promise<UserRecord | null> {
  const user = await queryOne(
    `SELECT u.*,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u WHERE u.id = ?`,
    [id],
  )
  if (!user) return null
  return {
    ...user,
    roles: parseRoles(user),
  } as unknown as UserRecord
}

/** Find a user by username. */
export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const user = await queryOne(
    `SELECT u.*,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u WHERE u.username = ?`,
    [username],
  )
  if (!user) return null
  return {
    ...user,
    roles: parseRoles(user),
  } as unknown as UserRecord
}

/** Find a user by email. */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const user = await queryOne(
    `SELECT u.*,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u WHERE u.email = ?`,
    [email],
  )
  if (!user) return null
  return {
    ...user,
    roles: parseRoles(user),
  } as unknown as UserRecord
}

/** Find or create an OAuth user. */
export async function findOrCreateOAuthUser(
  provider: string,
  providerUserId: string,
  providerUsername: string | null,
  providerDisplayName: string | null,
  providerAvatarUrl: string | null,
  providerEmail: string | null,
): Promise<{ user: UserRecord; isNew: boolean }> {
  const existing = await queryOne(
    `SELECT oa.userId, u.*,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM oauth_accounts oa
     JOIN users u ON u.id = oa.userId
     WHERE oa.provider = ? AND oa.providerUserId = ?`,
    [provider, providerUserId],
  )

  if (existing) {
    if (providerUsername || providerDisplayName) {
      await exec(
        `UPDATE oauth_accounts SET providerUsername = ?, providerDisplayName = ?, providerAvatarUrl = ?, updatedAt = ? WHERE provider = ? AND providerUserId = ?`,
        [providerUsername || null, providerDisplayName || null, providerAvatarUrl || null, Date.now(), provider, providerUserId],
      )
    }
    return { user: { ...existing, roles: parseRoles(existing) } as unknown as UserRecord, isNew: false }
  }

  const userId = ulid()
  const now = Date.now()
  const displayName = providerDisplayName || providerUsername || `user_${providerUserId.slice(0, 8)}`
  const username = `user_${ulid().slice(0, 12).toLowerCase()}`

  await exec(
    `INSERT INTO users (id, username, email, emailVerified, displayName, avatarUrl, status, createdAt, lastLoginAt)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [userId, username, providerEmail || null, !!providerEmail, displayName, providerAvatarUrl || null, now, now],
  )

  await exec(
    `INSERT INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), userId, provider, providerUserId, providerUsername || null, providerDisplayName || null, providerAvatarUrl || null, providerEmail || null, now, now],
  )

  const user = await findUserById(userId)
  return { user: user!, isNew: true }
}

/** Set user admin status. */
export async function setUserAdmin(userId: string, grantorUserId: string, isAdmin: boolean): Promise<void> {
  const role = await queryOne(`SELECT id FROM roles WHERE name = 'admin'`)
  if (!role) {
    const roleId = ulid()
    await exec(`INSERT INTO roles (id, name, description, createdAt) VALUES (?, 'admin', '系统管理员', ?)`, [roleId, Date.now()])
    if (isAdmin) {
      await exec(`INSERT INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`, [
        ulid(),
        userId,
        roleId,
        grantorUserId,
        Date.now(),
      ])
    }
    await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [userId])
    return
  }

  if (isAdmin) {
    await exec(`INSERT IGNORE INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`, [
      ulid(),
      userId,
      role.id,
      grantorUserId,
      Date.now(),
    ])
  } else {
    await exec(`DELETE FROM user_roles WHERE userId = ? AND roleId = ?`, [userId, role.id])
  }

  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [userId])
}
