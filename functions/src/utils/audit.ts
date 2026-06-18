/**
 * Audit log helper — writes append-only audit entries per api.md §8.
 * Handles ipHash/userAgentHash/prevHash/entryHash automatically.
 */
import type { Request } from 'express'
import { getConnection } from '../Database'
import { genId } from './ulid'
import { hmacToken } from './session'

export async function sha256base64url(data: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * Canonical JSON serialization with sorted keys (api.md §15.13).
 * Guarantees deterministic output for entryHash computation.
 */
export function canonicalJson(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => {
    const v = obj[k]
    if (v === null || v === undefined) return `"${k}":null`
    if (typeof v === 'object' && !Array.isArray(v)) {
      return `"${k}":${canonicalJson(v as Record<string, unknown>)}`
    }
    return `"${k}":${JSON.stringify(v)}`
  })
  return `{${parts.join(',')}}`
}

/**
 * Write an audit log entry with hash chain integrity.
 * Uses a transaction + FOR UPDATE to prevent hash chain forks (api.md §15.13).
 */
export async function writeAuditLog(
  req: Request,
  params: {
    actorUserId: string | null
    action: string
    resourceType: string
    resourceId: string | null
    before?: unknown | null
    after?: unknown | null
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const now = Date.now()
  const auditId = genId('aud_')

  const ipHash = await hmacToken(ip)       // hmac_sha256 per api.md §15.13
  const uaHash = await sha256base64url(ua) // sha256 per api.md §15.13

  // Build record data (without hash fields, for entryHash computation)
  const recordData: Record<string, unknown> = {
    id: auditId,
    actorUserId: params.actorUserId,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    before: params.before ?? null,
    after: params.after ?? null,
    metadata: params.metadata ?? {},
    createdAt: now,
    requestId: req.requestId,
    ipHash,
    uaHash,
  }

  // Use transaction + FOR UPDATE to prevent concurrent hash chain forks
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    const [lastRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT entryHash FROM audit_logs ORDER BY createdAt DESC LIMIT 1 FOR UPDATE`,
    )
    const prevHash = (lastRows[0]?.entryHash as string) ?? null

    const canonicalRecord = canonicalJson(recordData)
    const chainInput = prevHash ? `${prevHash}|${canonicalRecord}` : canonicalRecord
    const entryHash = await sha256base64url(chainInput)

    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        params.actorUserId,
        params.action,
        params.resourceType,
        params.resourceId,
        params.before ? canonicalJson(params.before as Record<string, unknown>) : null,
        params.after ? canonicalJson(params.after as Record<string, unknown>) : null,
        canonicalJson(params.metadata ?? {}),
        now,
        req.requestId,
        ipHash,
        uaHash,
        prevHash,
        entryHash,
      ],
    )

    await conn.commit()
  } catch {
    await conn.rollback().catch(() => {})
    // Best-effort — audit log failures must not block the main operation
  } finally {
    conn.release()
  }
}
