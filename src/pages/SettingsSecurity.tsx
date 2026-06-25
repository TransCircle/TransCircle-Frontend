import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, patch } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  PageHeader,
  Pill,
  Spinner,
  TextField,
} from '@/components/ui'
import { PERMISSION_LABEL_KEYS, ROLE_LABEL_KEYS } from '@/api/permissions'
import shell from './Page.module.css'
import s from './SettingsSecurity.module.css'

// ─── Types ───────────────────────────────────────────────────

interface UserSecurity {
  hasPassword: boolean
  totpEnabled: boolean
  passkeyCount: number
  oauthProviders: string[]
}

interface UserProfile {
  id: string
  username: string
  email: string | null
  displayName: string
  avatarUrl: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  security: UserSecurity
  createdAt: number
  lastLoginAt: number | null
}

// ─── Component ────────────────────────────────────────────────

export const SettingsSecurity = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user: authUser, loading: authLoading } = useAuth()

  // 全部账户（普通用户走 Pass、管理员走 IAM）的凭据/账户均由统一身份托管：
  // 本页只保留资料展示 + 数据导出 + 深链到 Pass 账户中心。
  const isManaged = !!authUser?.iamLinked || !!authUser?.passLinked

  // 「我的权限」概览：角色 + 细粒度权限。严格展示后端 /me 返回的权限快照本身（authUser.permissions），
  // 不用 useAuth().permissions 的角色派生回退，避免在展示层臆造权限。仅对实际拥有角色/权限的账号展示。
  const roles = authUser?.roles ?? []
  const permissions = authUser?.permissions ?? []
  const hasWildcard = permissions.includes('*')
  const hasAnyGrant = roles.length > 0 || permissions.length > 0
  const isIam = !!authUser?.iamLinked

  // ── Profile edit state (api.md §2.2) ──
  // 使用 AuthContext 已加载的用户资料（authUser），避免额外调用 /me
  const [profile, setProfile] = useState<UserProfile | null>(
    authUser
      ? {
          id: authUser.id,
          username: authUser.username,
          email: authUser.email,
          displayName: authUser.displayName,
          avatarUrl: authUser.avatarUrl,
          emailVerified: authUser.emailVerified,
          status: authUser.status,
          roles: authUser.roles ?? [],
          security: authUser.security as UserSecurity,
          createdAt: authUser.createdAt,
          lastLoginAt: authUser.lastLoginAt,
        }
      : null,
  )
  const [profileDisplayName, setProfileDisplayName] = useState(authUser?.displayName ?? '')
  const [profileError, setProfileError] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState(false)

  // ── GDPR export state (api.md §2.3) ──
  const [exportStatus, setExportStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [exportError, setExportError] = useState('')

  // ── Profile Edit (api.md §2.2) ──
  const handleProfileUpdate = async () => {
    setProfileError('')
    setProfileSuccess(false)

    const dn = profileDisplayName.trim()
    if (!dn || dn.length > 50) {
      setProfileError(t('settings.displayNameError'))
      return
    }

    setProfileSubmitting(true)
    const result = await patch<Record<string, unknown>>('/me', { displayName: dn })
    setProfileSubmitting(false)

    if (result.ok) {
      setProfileSuccess(true)
      setProfile(prev => prev ? { ...prev, displayName: dn } : prev)
    } else {
      setProfileError(result.error.message)
    }
  }

  // ── GDPR Export (api.md §2.3) ──
  const handleExport = async () => {
    setExportError('')
    setExportStatus('submitting')
    const result = await post('/me/export')
    if (result.ok) {
      setExportStatus('done')
    } else {
      setExportStatus('error')
      setExportError(result.error.message)
    }
  }

  // Not loading and not logged in — redirect to login
  useEffect(() => {
    if (!authUser && !authLoading) {
      navigate('/login', { replace: true })
    }
  }, [authUser, authLoading, navigate])

  if (!authUser) {
    if (authLoading) {
      return (
        <div className={`${shell.page} ${shell.pageNarrow}`}>
          <Spinner size="lg" label={t('admin.verifying')} />
        </div>
      )
    }
    return null
  }

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <PageHeader title={t('settings.pageTitle')} description={t('settings.pageDescription')} />

      {/* ══════════════════════════════════════════
          PROFILE (api.md §2.2)
          ══════════════════════════════════════════ */}
      <Card>
        <div className={shell.stack}>
          <h2 className={shell.detailTitle}>{t('settings.profileHeading')}</h2>

          {profile && (
            <DescriptionList
              columns={1}
              items={[
                { term: t('settings.username'), value: profile.username },
                { term: t('settings.email'), value: profile.email ?? '-' },
                { term: t('settings.emailVerified'), value: profile.emailVerified ? t('settings.yes') : t('settings.no') },
              ]}
            />
          )}

          <TextField
            label={t('settings.displayNameLabel')}
            value={profileDisplayName}
            onChange={e => setProfileDisplayName(e.target.value)}
            maxLength={50}
            required
            autoComplete="nickname"
          />

          {profileSuccess && <Alert tone="success">{t('settings.profileUpdated')}</Alert>}
          {profileError && <Alert tone="error">{profileError}</Alert>}

          <div className={shell.actions}>
            <AdminButton variant="primary" loading={profileSubmitting} disabled={!profileDisplayName.trim()} onClick={handleProfileUpdate}>
              {t('settings.saveProfile')}
            </AdminButton>
          </div>

          {/* GDPR 数据导出（api.md §2.3）*/}
          <div className={s.section}>
            <h3 className={s.subHeading}>{t('settings.exportHeading')}</h3>
            <p className={s.note}>{t('settings.exportDescription')}</p>
            {exportStatus === 'done' && <Alert tone="success">{t('settings.exportDone')}</Alert>}
            {exportError && <Alert tone="error">{exportError}</Alert>}
            <div className={shell.actions}>
              <AdminButton variant="secondary" loading={exportStatus === 'submitting'} onClick={handleExport}>
                {t('settings.requestExport')}
              </AdminButton>
            </div>
          </div>
        </div>
      </Card>

      {/* ══════════════════════════════════════════
          ACCOUNT SECURITY — 统一托管提示（不在本站管理，亦不给具体链接）
          所有用户的登录与账户安全一律由 TransCircle 统一账户中心管理。
          ══════════════════════════════════════════ */}
      {isManaged && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.securityHeading')}</h2>
            <Alert tone="info">{t('settings.passManagedNotice')}</Alert>
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          MY PERMISSIONS (我的权限) — 仅在拥有角色/权限时展示，
          让经统一身份登录的管理员清楚自己被授予了哪些权限
          ══════════════════════════════════════════ */}
      {hasAnyGrant && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.permissionsHeading')}</h2>
            <p className={s.note}>{isIam ? t('settings.permissionsDescriptionIam') : t('settings.permissionsDescription')}</p>

            {roles.length > 0 && (
              <div className={s.permGroup}>
                <p className={s.permGroupLabel}>{t('settings.permissionsRoles')}</p>
                <div className={s.chips}>
                  {roles.map(r => {
                    const key = ROLE_LABEL_KEYS[r]
                    return <Pill key={r} tone="accent">{key ? t(key) : r}</Pill>
                  })}
                </div>
              </div>
            )}

            <div className={s.permGroup}>
              <p className={s.permGroupLabel}>{t('settings.permissionsList')}</p>
              {hasWildcard ? (
                <div className={s.chips}>
                  <Pill tone="accent">{t('settings.permissionsWildcard')}</Pill>
                </div>
              ) : permissions.length === 0 ? (
                <p className={s.note}>{t('settings.permissionsNone')}</p>
              ) : (
                <div className={s.chips}>
                  {permissions.map(p => {
                    const key = PERMISSION_LABEL_KEYS[p]
                    return <Pill key={p}>{key ? t(key) : p}</Pill>
                  })}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
