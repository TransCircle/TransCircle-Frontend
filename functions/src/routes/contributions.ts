import { Router, type Router as RouterType } from 'express';
import { exec } from '../Database';
import { ulid } from '../utils/ulid';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { optionalAuth } from '../middleware/auth';
import { contributionSchema } from '../utils/validation';
import { rateLimitCheck } from '../middleware/rateLimit';

const router: RouterType = Router();

// ──────────────────────────────────────────────
// POST /contributions
// Submit a new contribution
// ──────────────────────────────────────────────
router.post('/', (req, _res, next) => { req.rateLimitAction = 'submit'; next(); }, rateLimitCheck, optionalAuth, async (req, res) => {
  const parsed = contributionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 400, parsed.error.flatten());
    return;
  }

  const data = parsed.data;

  // Honeypot check — if filled, silently reject (bot)
  if (data.website && data.website.length > 0) {
    // Fake success to not tip off bots
    const fakeId = `TC-${ulid().slice(0, 12)}`;
    sendSuccess(res, { id: fakeId, status: 'pending' }, req.requestId);
    return;
  }

  // Validate authorName if not anonymous
  if (data.authorType !== 'anonymous' && !data.authorName?.trim()) {
    sendError(res, Errors.VALIDATION_ERROR.code, '实名/笔名投稿必须填写署名', req.requestId, 400);
    return;
  }

  const id = ulid();
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  function simpleHash(s: string): string {
    let h = 0;
    for (const c of s) {
      h = ((h << 5) - h) + c.charCodeAt(0);
      h |= 0;
    }
    return Math.abs(h).toString(36);
  }

  const ipHash = simpleHash(ip);
  const uaHash = simpleHash(ua);

  await exec(
    `INSERT INTO contributions (id, authorUserId, title, contentRaw, contentFormat, contentHtml, rendererVersion, status, version, language, tags, authorType, authorName, contact, category, submitterIpHash, submitterUserAgentHash, submittedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.user?.userId || null,
      data.title.trim(),
      data.content,
      data.contentFormat,
      data.content, // simplified: raw = html for now (no markdown rendering server-side)
      'v1',
      data.language,
      JSON.stringify(data.tags),
      data.authorType,
      data.authorType !== 'anonymous' ? data.authorName : null,
      data.contact || null,
      data.category,
      ipHash,
      uaHash,
      now,
      now,
      now,
    ],
  );

  sendSuccess(res, { id, status: 'pending' }, req.requestId, 201);
});

export default router;
