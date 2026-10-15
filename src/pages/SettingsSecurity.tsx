import { useEffect, useState, type MouseEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, patch } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { AdminButton, Alert, BrandText, Card, DescriptionList, PageHeader, Pill, TextField } from '@/components/ui'
import { PERMISSION_LABEL_KEYS, ROLE_LABEL_KEYS } from '@/api/permissions'
import { useSectionSpy } from '@/hooks/useSectionSpy'
import { focusTarget } from '@/utils/focusTarget'
import shell from './Account.module.css'
import s from './SettingsSecurity.module.css'

/** 分区 id：页面锚点、侧导航与 ?tab= 深链共用。 */
const SETTINGS_SECTION_IDS = ['profile', 'security', 'permissions'] as const
type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
  const { user: authUser } = useAuth()
  const [searchParams] = useSearchParams()
  const location = useLocation()

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
    try {
      const result = await patch<Record<string, unknown>>('/me', { displayName: dn })
      if (result.ok) {
        setProfileSuccess(true)
        setProfile((prev) => (prev ? { ...prev, displayName: dn } : prev))
      } else {
        setProfileError(result.error.message || t('settings.requestFailed'))
      }
    } finally {
      setProfileSubmitting(false)
    }
  }

  // ── GDPR Export (api.md §2.3) ──
  const handleExport = async () => {
    setExportError('')
    setExportStatus('submitting')
    try {
      const result = await post('/me/export')
      if (result.ok) {
        setExportStatus('done')
      } else {
        setExportStatus('error')
        setExportError(result.error.message || t('settings.requestFailed'))
      }
    } catch {
      setExportStatus('error')
      setExportError(t('settings.requestFailed'))
    }
  }

  /* ── 分区导航（同 Pass 账户中心）：≥1024 左侧粘性导航 + 滚动监听；
     ?tab=<id> 进入时滚到对应分区并把焦点放在分区标题上。 ── */
  const sections: { id: SettingsSectionId; label: string }[] = [
    { id: 'profile', label: t('settings.profileHeading') },
    ...(isManaged ? [{ id: 'security' as const, label: t('settings.securityHeading') }] : []),
    ...(hasAnyGrant ? [{ id: 'permissions' as const, label: t('settings.permissionsHeading') }] : []),
  ]
  const sectionIds = sections.map((x) => x.id)
  const activeSection = useSectionSpy(sectionIds)

  /** 滚到分区并把焦点放在分区标题上（标题有可见焦点环，读屏念出分区名）。 */
  const goToSection = (id: string, behavior: ScrollBehavior) => {
    const target = document.getElementById(id)
    if (!target) return
    target.scrollIntoView({ behavior, block: 'start' })
    focusTarget(target.querySelector<HTMLElement>('h2') ?? target)
  }

  /* 深链落地：URL 里有效的 #分区 优先（分区链接 Ctrl/中键在新标签打开时只带 hash），
     其次 ?tab=（登录后回跳用）。两者都无效时不动。 */
  const requestedTab = searchParams.get('tab')
  const hashSection = location.hash.slice(1)
  const landingSection = SETTINGS_SECTION_IDS.includes(hashSection as SettingsSectionId)
    ? hashSection
    : requestedTab && SETTINGS_SECTION_IDS.includes(requestedTab as SettingsSectionId)
      ? requestedTab
      : null
  useEffect(() => {
    if (!landingSection) return
    // 下一帧再定位：等外壳的换页滚动归零与焦点落定之后，子页面的定位才是最终结果。
    // instant：深链落地是「定位」不是动画；'auto' 会跟随 html 的 scroll-behavior: smooth 慢慢滑过去。
    const raf = window.requestAnimationFrame(() => goToSection(landingSection, 'instant'))
    return () => window.cancelAnimationFrame(raf)
  }, [landingSection])

  const onNavClick = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    goToSection(id, prefersReducedMotion() ? 'instant' : 'smooth')
  }

  return (
    <div className={shell.page}>
      <PageHeader title={t('settings.pageTitle')} description={t('settings.pageDescription')} />

      <div className={shell.settingsLayout}>
        <nav className={shell.sideNav} aria-label={t('settings.pageTitle')}>
          <ul className={shell.sideNavList}>
            {sections.map((item) => (
              <li key={item.id}>
                {/* ?tab= 而不是 #hash：未登录打开这条链接时，登录回跳只保留 path + search。 */}
                <a
                  href={`?tab=${item.id}`}
                  className={shell.sideNavLink}
                  aria-current={activeSection === item.id ? 'location' : undefined}
                  onClick={onNavClick(item.id)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className={shell.sections}>
          {/* ══ 个人资料（api.md §2.2）══ */}
          <section id="profile" className={shell.sectionCard} aria-labelledby="settings-profile-title">
            <Card>
              <div className={shell.stack}>
                <h2 id="settings-profile-title" className={shell.cardTitle}>
                  {t('settings.profileHeading')}
                </h2>

                {profile && (
                  <DescriptionList
                    columns={1}
                    items={[
                      { term: t('settings.username'), value: profile.username },
                      { term: t('settings.email'), value: profile.email ?? '—' },
                      {
                        term: t('settings.emailVerified'),
                        value: profile.emailVerified ? t('settings.yes') : t('settings.no'),
                      },
                    ]}
                  />
                )}

                <TextField
                  label={t('settings.displayNameLabel')}
                  value={profileDisplayName}
                  onChange={(e) => setProfileDisplayName(e.target.value)}
                  maxLength={50}
                  required
                  autoComplete="nickname"
                />

                {profileSuccess && <Alert tone="success">{t('settings.profileUpdated')}</Alert>}
                {profileError && <Alert tone="error">{profileError}</Alert>}

                <div className={shell.actions}>
                  <AdminButton
                    variant="primary"
                    loading={profileSubmitting}
                    disabled={!profileDisplayName.trim()}
                    onClick={handleProfileUpdate}
                  >
                    {t('settings.saveProfile')}
                  </AdminButton>
                </div>

                {/* GDPR 数据导出（api.md §2.3）*/}
                <div className={shell.subSection}>
                  <h3 className={shell.subHeading}>{t('settings.exportHeading')}</h3>
                  <p className={shell.subtleNote}>{t('settings.exportDescription')}</p>
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
          </section>

          {/* ══ 账户安全：统一托管提示（不在本站管理，亦不给具体链接）══
              所有用户的登录与账户安全一律由 TransCircle 统一账户中心管理。 */}
          {isManaged && (
            <section id="security" className={shell.sectionCard} aria-labelledby="settings-security-title">
              <Card>
                <div className={shell.stack}>
                  <h2 id="settings-security-title" className={shell.cardTitle}>
                    {t('settings.securityHeading')}
                  </h2>
                  <Alert tone="info">
                    <BrandText text={t('settings.passManagedNotice')} />
                  </Alert>
                </div>
              </Card>
            </section>
          )}

          {/* ══ 我的权限：仅在拥有角色/权限时展示，让经统一身份登录的管理员清楚自己被授予了哪些权限 ══ */}
          {hasAnyGrant && (
            <section id="permissions" className={shell.sectionCard} aria-labelledby="settings-permissions-title">
              <Card>
                <div className={shell.stack}>
                  <h2 id="settings-permissions-title" className={shell.cardTitle}>
                    {t('settings.permissionsHeading')}
                  </h2>
                  <p className={shell.subtleNote}>
                    <BrandText
                      text={isIam ? t('settings.permissionsDescriptionIam') : t('settings.permissionsDescription')}
                    />
                  </p>

                  {roles.length > 0 && (
                    <div className={s.permGroup}>
                      <p className={s.permGroupLabel}>{t('settings.permissionsRoles')}</p>
                      <div className={s.chips}>
                        {roles.map((r) => {
                          const key = ROLE_LABEL_KEYS[r]
                          return (
                            <Pill key={r} tone="accent">
                              {key ? t(key) : r}
                            </Pill>
                          )
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
                      <p className={shell.subtleNote}>{t('settings.permissionsNone')}</p>
                    ) : (
                      <div className={s.chips}>
                        {permissions.map((p) => {
                          const key = PERMISSION_LABEL_KEYS[p]
                          return <Pill key={p}>{key ? t(key) : p}</Pill>
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
