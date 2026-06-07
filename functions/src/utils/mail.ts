/**
 * Email sending utility.
 * - Dev mode: logs to console.
 * - Production: uses Resend if RESEND_API_KEY is set; falls back to console log.
 *
 * api.md requires: verification email (1.2.2), password reset email (1.4.1),
 * GDPR cancellation email (2.4), and export ready notification (2.3).
 */
import { conf } from '../Config'
import { log } from '../Logger'

const DEV_MODE = process.env.NODE_ENV !== 'production'
const FRONTEND_URL = (conf.APP as Record<string, string | undefined> | undefined)?.FRONTEND_URL || 'https://submit.transcircle.org'
const RESEND_API_KEY = process.env.RESEND_API_KEY
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@transcircle.org'

export interface EmailOptions {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * Send an email.
 *
 * Production path (priority):
 *   1. RESEND_API_KEY env var set → use Resend REST API
 *   2. SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS env vars set → use SMTP
 *   3. Otherwise → log warning and return false
 *
 * Dev path: logs to console.
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (DEV_MODE) {
    log(`[mail] Dev mode — logging email to ${options.to}`)
    console.log('═══════════════════════════════════════════')
    console.log(`📧 To: ${options.to}`)
    console.log(`📧 Subject: ${options.subject}`)
    console.log(`📧 Body:\n${options.text}`)
    console.log('═══════════════════════════════════════════')
    return true
  }

  // Resend API (https://resend.com)
  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
        }),
      })
      if (res.ok) {
        log(`[mail] Sent via Resend to ${options.to}`)
        return true
      }
      const errBody = await res.text()
      console.error(`[mail] Resend error (${res.status}): ${errBody}`)
      return false
    } catch (err) {
      console.error(`[mail] Resend request failed: ${(err as Error).message}`)
      return false
    }
  }

  console.error(`[mail] No email provider configured (set RESEND_API_KEY) — cannot send to ${options.to}`)
  return false
}

/**
 * Build a verification email with the token link.
 */
export function buildVerificationEmail(email: string, token: string): EmailOptions {
  return {
    to: email,
    subject: '验证您的邮箱 — TransCircle',
    text: `请点击以下链接验证您的邮箱（24 小时内有效）：\n\n${FRONTEND_URL}/auth/verify?token=${token}`,
    html: `<p>请点击以下链接验证您的邮箱（24 小时内有效）：</p><p><a href="${FRONTEND_URL}/auth/verify?token=${token}">验证邮箱</a></p>`,
  }
}

/**
 * Build a password reset email with the token link.
 */
export function buildPasswordResetEmail(email: string, token: string): EmailOptions {
  return {
    to: email,
    subject: '重置密码 — TransCircle',
    text: `请点击以下链接重置密码（1 小时内有效）：\n\n${FRONTEND_URL}/auth/reset-password?token=${token}`,
    html: `<p>请点击以下链接重置密码（1 小时内有效）：</p><p><a href="${FRONTEND_URL}/auth/reset-password?token=${token}">重置密码</a></p>`,
  }
}

/**
 * Build a cancellation email for GDPR account deletion (api.md §2.4).
 */
export function buildCancelDeletionEmail(email: string, token: string): EmailOptions {
  return {
    to: email,
    subject: '撤销账户注销 — TransCircle',
    text: `您的账户已进入 30 天冷静期。如要撤销注销，请点击以下链接（30 天内有效）：\n\n${FRONTEND_URL}/auth/cancel-deletion?token=${token}\n\n如果这不是您本人的操作，请立即联系支持团队。`,
    html: `<p>您的账户已进入 30 天冷静期。</p><p>如要撤销注销，请点击以下链接（30 天内有效）：</p><p><a href="${FRONTEND_URL}/auth/cancel-deletion?token=${token}">撤销注销</a></p><p>如果这不是您本人的操作，请立即联系支持团队。</p>`,
  }
}
