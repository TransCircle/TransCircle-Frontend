import { queryOne, exec } from '../Database'
import { genId } from './ulid'

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
  updatedAt: number
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
async function fetchRoles(userId: string): Promise<string[]> {
  try {
    const rows = await import('../Database').then(d => d.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
      [userId],
    ))
    return (rows as Array<{ name: string }>).map(r => r.name)
  } catch {
    return []
  }
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
    `SELECT * FROM users WHERE id = ?`,
    [id],
  )
  if (!user) return null
  return {
    ...user,
    roles: await fetchRoles(id),
  } as unknown as UserRecord
}

/** Find a user by username. */
export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const user = await queryOne(
    `SELECT * FROM users WHERE username = ?`,
    [username],
  )
  if (!user) return null
  return {
    ...user,
    roles: await fetchRoles(user.id as string),
  } as unknown as UserRecord
}

/** Find a user by email. */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const user = await queryOne(
    `SELECT * FROM users WHERE email = ?`,
    [email],
  )
  if (!user) return null
  return {
    ...user,
    roles: await fetchRoles(user.id as string),
  } as unknown as UserRecord
}


/** Set user admin status. */
export async function setUserAdmin(userId: string, grantorUserId: string, isAdmin: boolean): Promise<void> {
  const role = await queryOne(`SELECT id FROM roles WHERE name = 'admin'`)
  if (!role) {
    const roleId = genId('role_')
    await exec(`INSERT INTO roles (id, name, description, createdAt) VALUES (?, 'admin', '系统管理员', ?)`, [roleId, Date.now()])
    if (isAdmin) {
      await exec(`INSERT INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`, [
        genId('ur_'),
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
      genId('ur_'),
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
