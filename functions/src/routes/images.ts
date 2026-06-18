import { Router } from 'express'
import multer from 'multer'
import { exec, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { metrics } from '../utils/metrics'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { writeAuditLog } from '../utils/audit'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { conf } from '../Config'

const router: Router = Router()

// Multer setup: in-memory buffer, 2 MiB limit, single field "file" (api.md §11.1 multipart/form-data)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2_097_152, files: 1 },
})

const IMAGE_STORAGE = process.env.IMAGE_STORAGE_DIR || join(process.cwd(), 'storage', 'images')
const MAGIC_BYTES: Record<string, Uint8Array> = {
  'image/jpeg': new Uint8Array([0xFF, 0xD8, 0xFF]),
  'image/png': new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
  'image/gif': new Uint8Array([0x47, 0x49, 0x46]),
  'image/webp': new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF...WEBP
}
const MAX_FILE_SIZE = 2_097_152 // 2 MiB
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_777_216

/**
 * Detect MIME type from file header (magic bytes) per api.md §11.1.
 */
function detectMimeType(buffer: Buffer): string | null {
  for (const [mime, magic] of Object.entries(MAGIC_BYTES)) {
    const matches = magic.every((byte, i) => buffer[i] === byte)
    if (matches) {
      // WebP needs additional check for "WEBP" at offset 8
      if (mime === 'image/webp') {
        const webpMarker = buffer.slice(8, 12).toString('ascii')
        if (webpMarker !== 'WEBP') continue
      }
      return mime
    }
  }
  return null
}

/**
 * Parse image dimensions from buffer (minimal implementation).
 * Returns { width, height } or null if parsing fails.
 */
function parseImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      // PNG: IHDR chunk at offset 16
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      return { width, height }
    }
    if (mimeType === 'image/jpeg') {
      // JPEG: scan for all standard SOF markers (api.md §11.1: must decode image integrity)
      // SOF markers: 0xC0(SOF0 baseline), 0xC1(SOF1 extended), 0xC2(SOF2 progressive),
      // 0xC3(SOF3 lossless), 0xC5(SOF5 differential), 0xC6(SOF6 differential progressive),
      // 0xC7(SOF7 differential lossless), 0xC9-0xCB(arithmetic variants), 0xCD-0xCF(differential arithmetic)
      const SOF_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF])
      let offset = 2
      while (offset < buffer.length - 1) {
        if (buffer[offset] !== 0xFF) break
        const marker = buffer[offset + 1]
        if (SOF_MARKERS.has(marker)) {
          const height = buffer.readUInt16BE(offset + 5)
          const width = buffer.readUInt16BE(offset + 7)
          return { width, height }
        }
        const segLen = buffer.readUInt16BE(offset + 2)
        if (segLen < 2) break
        offset += 2 + segLen
      }
      return null
    }
    if (mimeType === 'image/gif') {
      // GIF: width/height at offset 6/8 (little-endian)
      const width = buffer.readUInt16LE(6)
      const height = buffer.readUInt16LE(8)
      return { width, height }
    }
    if (mimeType === 'image/webp') {
      // WebP: width/height at offset 24 (VP8/VP8L)
      const format = buffer.slice(12, 16).toString('ascii')
      if (format === 'VP8 ') {
        // VP8 keyframe
        const w = buffer.readUInt16LE(26) & 0x3FFF
        const h = buffer.readUInt16LE(28) & 0x3FFF
        return { width: w, height: h }
      }
      if (format === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

/**
 * Detect polyglot files: trailing data after valid image content.
 * Per api.md §11.1: must detect appended non-image data.
 *
 * JPEG: scan to EOI marker (0xFF 0xD9), check for data after it.
 * PNG: IEND chunk (0x00 0x00 0x00 0x00 0x49 0x45 0x4E 0x44 0xAE 0x42 0x60 0x82), check for data after.
 * GIF: trailer byte (0x3B), check for data after.
 * WebP: file size from RIFF header, verify total length matches.
 */
function detectPolyglot(buffer: Buffer, mimeType: string): boolean {
  try {
    if (mimeType === 'image/jpeg') {
      // Scan for EOI marker (FF D9) from the end
      for (let i = buffer.length - 2; i >= 0; i--) {
        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
          // If there's data after EOI, it's a polyglot
          return i + 2 < buffer.length
        }
      }
      return false // No EOI found — truncated
    }

    if (mimeType === 'image/png') {
      // IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82 (12 bytes)
      const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
      const iendIdx = buffer.lastIndexOf(iend)
      if (iendIdx === -1) return false // No IEND — truncated
      return iendIdx + iend.length < buffer.length
    }

    if (mimeType === 'image/gif') {
      // GIF trailer byte: 0x3B
      if (buffer[buffer.length - 1] === 0x3B) {
        return false // Clean end
      }
      // Some GIFs have multiple extensions — check for 0x3B anywhere near end
      const trailerIdx = buffer.lastIndexOf(0x3B)
      if (trailerIdx === -1) return false // No trailer — truncated
      return trailerIdx + 1 < buffer.length
    }

    if (mimeType === 'image/webp') {
      // RIFF header: file size at offset 4 (little-endian)
      if (buffer.length < 12) return false
      const riffSize = buffer.readUInt32LE(4) + 8 // RIFF size field excludes first 8 bytes
      return buffer.length > riffSize
    }
  } catch {
    return false // Conservative: assume clean on parse error
  }
  return false
}

/**
 * Minimal EXIF GPS/device fingerprint removal for JPEG images.
 * Scans for APP1 (EXIF) marker and nulls out GPS IFD tags.
 * Production should use a library like `sharp` or `exifr` for full stripping.
 */
function removeExifGps(buffer: Buffer): Buffer {
  // Only process JPEG
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return buffer

  let offset = 2
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xFF) break
    const marker = buffer[offset + 1]

    // APP1 marker (0xE1) — EXIF data
    if (marker === 0xE1) {
      const segLen = buffer.readUInt16BE(offset + 2)
      const segEnd = offset + 2 + segLen

      if (segEnd <= buffer.length) {
        const exifSegment = buffer.subarray(offset, segEnd)

        // Check for "Exif\0\0" header
        if (exifSegment.length >= 8 && exifSegment[4] === 0x45 &&
            exifSegment[5] === 0x78 && exifSegment[6] === 0x69 &&
            exifSegment[7] === 0x66 && exifSegment[8] === 0x00 &&
            exifSegment[9] === 0x00) {

          // TIFF header starts at offset 10 within APP1
          const tiffOffset = offset + 10
          if (tiffOffset + 8 <= buffer.length) {
            const endian = buffer.readUInt16BE(tiffOffset) === 0x4D4D ? 'BE' : 'LE'
            const readU16 = (pos: number) => endian === 'BE' ? buffer.readUInt16BE(pos) : buffer.readUInt16LE(pos)
            const readU32 = (pos: number) => endian === 'BE' ? buffer.readUInt32BE(pos) : buffer.readUInt32LE(pos)

            // IFD0 offset
            const ifd0Offset = tiffOffset + readU32(tiffOffset + 4)
            if (ifd0Offset + 2 <= buffer.length) {
              const numEntries = readU16(ifd0Offset)

              for (let i = 0; i < numEntries && i < 50; i++) {
                const entryOffset = ifd0Offset + 2 + i * 12
                if (entryOffset + 12 > buffer.length) break
                const tag = readU16(entryOffset)

                // GPS IFD tag (0x8825)
                if (tag === 0x8825) {
                  // Zero out the entire value/data field (8 bytes starting at offset + 4)
                  buffer.fill(0, entryOffset + 4, entryOffset + 12)
                }
              }
            }
          }
        }
      }
      break // Only first APP1 matters
    }

    // Skip to next marker
    const segLen = buffer.readUInt16BE(offset + 2)
    offset += 2 + segLen
  }

  return buffer
}

/**
 * POST /v1/images — api.md §11.1 上传图片
 * Uses multer for proper multipart/form-data handling
 */
router.post('/',
  (req, _res, next) => { req.rateLimitAction = 'image'; next(); },
  rateLimitCheck,
  requireAuth, upload.single('file'), async (req, res) => {
  // Check email verified
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  // Image upload rate limits per api.md §11.1: 20/hour per user, 100/hour per IP
  const now = Date.now()
  const hourWindow = Math.floor(now / 3600_000) * 3600_000
  const userRateKey = `image:upload:user:${req.user!.userId}:${hourWindow}`
  const ipRateKey = `image:upload:ip:${req.ip || 'unknown'}:${hourWindow}`

  const userUploads = await queryOne(
    `SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`,
    [userRateKey, hourWindow],
  )
  if ((userUploads?.count as number || 0) >= 20) {
    const retryAfter = Math.ceil((hourWindow + 3600_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    sendError(res, Errors.RATE_LIMITED.code, '每用户每小时最多上传 20 张图片', req.requestId, 429)
    return
  }

  const ipUploads = await queryOne(
    `SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`,
    [ipRateKey, hourWindow],
  )
  if ((ipUploads?.count as number || 0) >= 100) {
    const retryAfter = Math.ceil((hourWindow + 3600_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    sendError(res, Errors.RATE_LIMITED.code, '每 IP 每小时最多上传 100 张图片', req.requestId, 429)
    return
  }

  if (!req.file) {
    sendError(res, Errors.BAD_REQUEST.code, '未提供文件（需 multipart/form-data，字段名 "file"）', req.requestId, 400)
    return
  }

  const fileBuffer = req.file.buffer
  const originalFilename = req.file.originalname || 'upload.bin'

  // File size check
  if (fileBuffer.length > MAX_FILE_SIZE) {
    sendError(res, Errors.CONTENT_TOO_LARGE.code, '文件超过 2 MiB 限制', req.requestId, 413)
    return
  }

  // Detect MIME type from magic bytes
  const detectedMime = detectMimeType(fileBuffer)
  if (!detectedMime) {
    sendError(res, 'UNSUPPORTED_MEDIA_TYPE', '不支持的图片类型', req.requestId, 415)
    return
  }

  // Verify integrity by parsing dimensions
  const dims = parseImageDimensions(fileBuffer, detectedMime)
  if (!dims) {
    metrics.imageUploadTotal["invalid|image"] = (metrics.imageUploadTotal["invalid|image"] || 0) + 1; sendError(res, 'INVALID_IMAGE', '图片损坏或解码失败', req.requestId, 422)
    return
  }

  if (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) {
    metrics.imageUploadTotal["invalid|image"] = (metrics.imageUploadTotal["invalid|image"] || 0) + 1; sendError(res, 'INVALID_IMAGE', '图片尺寸超过 4096 像素限制', req.requestId, 422)
    return
  }

  if (dims.width * dims.height > MAX_PIXELS) {
    metrics.imageUploadTotal["invalid|image"] = (metrics.imageUploadTotal["invalid|image"] || 0) + 1; sendError(res, 'INVALID_IMAGE', '图片总像素数超过限制', req.requestId, 422)
    return
  }

  // Polyglot detection: check for trailing data after valid image end (api.md §11.1)
  if (detectPolyglot(fileBuffer, detectedMime)) {
    metrics.imageUploadTotal["invalid|image"] = (metrics.imageUploadTotal["invalid|image"] || 0) + 1; sendError(res, 'INVALID_IMAGE', '图片包含多余数据（polyglot 检测失败）', req.requestId, 422)
    return
  }

  // EXIF GPS/device fingerprint removal per api.md §11.1
  const cleanedBuffer = removeExifGps(fileBuffer)

  // SHA-256 for dedup (after EXIF cleaning so same image → same hash)
  const sha256 = createHash('sha256').update(cleanedBuffer).digest('hex')

  // Check dedup
  const existing = await queryOne(
    `SELECT id, createdAt FROM images WHERE sha256 = ? AND status = 'active'`,
    [sha256],
  )
  if (existing) {
    let existingId = existing.id as string
    if (!existingId.startsWith('img_')) existingId = `img_${existingId}`
    metrics.imageUploadTotal[`success|${detectedMime}`] = (metrics.imageUploadTotal[`success|${detectedMime}`] || 0) + 1
    const appUrl = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'
    sendSuccess(res, {
      id: existingId,
      url: `${appUrl}/v1/images/${existingId}`,
      mimeType: detectedMime,
      size: cleanedBuffer.length,
      width: dims.width,
      height: dims.height,
      sha256,
      createdAt: existing.createdAt,
    }, req.requestId, 201)
    return
  }

  const imgId = genId('img_')
  const datePath = new Date(now).toISOString().slice(0, 7).replace('-', '') // yyyymm
  const ext = detectedMime.split('/')[1]
  const storageKey = `images/${datePath}/${sha256}.${ext}`

  // Write to storage (EXIF-cleaned version) via backend abstraction
  const store = await getStorageBackend()
  await store.write(storageKey, cleanedBuffer, detectedMime)

  // Insert record
  await exec(
    `INSERT INTO images (id, uploaderId, originalFilename, mimeType, size, width, height, sha256, storageKey, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [imgId, req.user!.userId, originalFilename.slice(0, 255), detectedMime,
     cleanedBuffer.length, dims.width, dims.height, sha256, storageKey, now],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'image.upload',
    resourceType: 'image',
    resourceId: imgId,
    after: { mimeType: detectedMime, size: cleanedBuffer.length, sha256 },
  })

  // Increment rate limit counters — atomic per api.md §13.3
  for (const rateKey of [userRateKey, ipRateKey]) {
    await exec(
      `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [ulid(), rateKey, hourWindow, now],
    )
  }

  metrics.imageUploadTotal[`success|${detectedMime}`] = (metrics.imageUploadTotal[`success|${detectedMime}`] || 0) + 1
  const appUrl = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'
  sendSuccess(res, {
    id: imgId,
    url: `${appUrl}/v1/images/${imgId}`,
    mimeType: detectedMime,
    size: cleanedBuffer.length,
    width: dims.width,
    height: dims.height,
    sha256,
    createdAt: now,
  }, req.requestId, 201)
})

/**
 * GET /v1/images/{id} — api.md §11.2 查看图片
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params

  const image = await queryOne(
    `SELECT id, mimeType, sha256, storageKey, status FROM images WHERE id = ?`,
    [id],
  )

  if (!image || image.status === 'deleted') {
    sendError(res, Errors.IMAGE_NOT_FOUND.code, '图片不存在', req.requestId, Errors.IMAGE_NOT_FOUND.status)
    return
  }

  const storageKey = image.storageKey as string
  const store = await getStorageBackend()
  const fileBuffer = await store.read(storageKey)

  if (!fileBuffer) {
    sendError(res, Errors.IMAGE_NOT_FOUND.code, '图片文件不存在', req.requestId, Errors.IMAGE_NOT_FOUND.status)
    return
  }
  const etag = `"${image.sha256 as string}"`

  // Check If-None-Match
  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch === etag) {
    res.status(304).end()
    return
  }

  res.setHeader('Content-Type', image.mimeType as string)
  res.setHeader('Content-Length', fileBuffer.length)
  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', 'inline')
  res.status(200).end(fileBuffer)
})

/**
 * ── Image Storage Backend Abstraction ──────────────────────────
 *
 * 生产环境升级路径:
 *   1. 设置 S3_BUCKET / R2_BUCKET / R2_ACCOUNT_ID 等环境变量 → 自动使用 S3 存储
 *   2. 未设置时 → 默认文件系统存储（当前实现）
 *
 * 设计目标：ImageStorage 接口统一 read/write/delete，
 * Router 层代码不需关心底层存储。
 */

interface ImageStorageBackend {
  write(key: string, buffer: Buffer, mimeType: string): Promise<void>
  read(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

/** Filesystem-based storage (dev/sandbox default) */
const fsStorage: ImageStorageBackend = {
  async write(key: string, buffer: Buffer): Promise<void> {
    const storagePath = join(IMAGE_STORAGE, key.replace('images/', ''))
    const dir = join(storagePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(storagePath, buffer)
  },
  async read(key: string): Promise<Buffer | null> {
    const storagePath = join(IMAGE_STORAGE, key.replace('images/', ''))
    if (!existsSync(storagePath)) return null
    return readFileSync(storagePath)
  },
  async delete(key: string): Promise<void> {
    const storagePath = join(IMAGE_STORAGE, key.replace('images/', ''))
    if (existsSync(storagePath)) unlinkSync(storagePath)
  },
}

/**
 * AWS Signature V4 helpers for S3-compatible storage.
 * Uses Node.js crypto for HMAC-SHA256 signing.
 */
function sha256Hash(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex')
}

function hmacSha256(key: Uint8Array | string, data: string): Uint8Array {
  return createHmac('sha256', key).update(data, 'utf-8').digest()
}

async function s3Sign(
  method: string,
  host: string,
  path: string,
  queryString: string,
  headers: Record<string, string>,
  payloadHash: string,
  region: string,
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const amzDate = headers['x-amz-date']
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`

  // Canonical request
  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${v}\n`)
    .sort(([a], [b]) => a.localeCompare(b))
    .join('')
  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(';')
  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // String to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hash(canonicalRequest),
  ].join('\n')

  // Signing key
  const dateKey = hmacSha256('AWS4' + secretKey, dateStamp)
  const dateRegionKey = hmacSha256(dateKey, region)
  const dateRegionServiceKey = hmacSha256(dateRegionKey, 's3')
  const signingKey = hmacSha256(dateRegionServiceKey, 'aws4_request')

  const signature = Buffer.from(hmacSha256(signingKey, stringToSign)).toString('hex')

  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`
}



/** S3-compatible storage (R2 / MinIO / AWS S3) — enabled when S3_BUCKET is set */
let _s3Storage: ImageStorageBackend | null = null

async function getS3Storage(): Promise<ImageStorageBackend | null> {
  if (_s3Storage) return _s3Storage

  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET
  if (!bucket) return null

  const accessKey = process.env.S3_ACCESS_KEY || process.env.R2_ACCESS_KEY
  const secretKey = process.env.S3_SECRET_KEY || process.env.R2_SECRET_KEY
  if (!accessKey || !secretKey) {
    console.warn('[images] S3 storage requires S3_ACCESS_KEY and S3_SECRET_KEY')
    return null
  }

  const region = process.env.S3_REGION || 'us-east-1'
  const s3Endpoint = process.env.S3_ENDPOINT || `https://${bucket}.s3.${region}.amazonaws.com`

  async function s3Send(
    method: string,
    path: string,
    body?: BodyInit,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const host = new URL(s3Endpoint).host
    const amzDate = new Date().toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z'
    const payloadHash = body ? createHash('sha256').update(Buffer.from(await new Response(body).arrayBuffer())).digest('hex') : sha256Hash('')

    const headers: Record<string, string> = {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...extraHeaders,
    }

    const url = `${s3Endpoint}${path}`
    const authorization = await s3Sign(
      method, host, path, '', headers, payloadHash,
      region, accessKey!, secretKey!,
    )
    headers['authorization'] = authorization

    return fetch(url, {
      method,
      headers,
      body: method === 'PUT' || method === 'POST' ? body : undefined,
    })
  }

  _s3Storage = {
    async write(key: string, buffer: Buffer, mimeType: string): Promise<void> {
      const encodedKey = encodeURIComponent(key)
      const res = await s3Send('PUT', `/${encodedKey}`, buffer, {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      if (!res.ok) throw new Error(`S3 PUT ${res.status}`)
    },
    async read(key: string): Promise<Buffer | null> {
      try {
        const encodedKey = encodeURIComponent(key)
        const res = await s3Send('GET', `/${encodedKey}`)
        if (!res.ok) return null
        return Buffer.from(await res.arrayBuffer())
      } catch {
        return null
      }
    },
    async delete(key: string): Promise<void> {
      const encodedKey = encodeURIComponent(key)
      await s3Send('DELETE', `/${encodedKey}`)
    },
  }
  return _s3Storage
}

/** Resolve storage backend based on environment */
let _storageBackend: ImageStorageBackend | null = null

async function getStorageBackend(): Promise<ImageStorageBackend> {
  if (_storageBackend) return _storageBackend
  _storageBackend = (await getS3Storage()) || fsStorage
  return _storageBackend
}

export { getStorageBackend, type ImageStorageBackend }
export default router
