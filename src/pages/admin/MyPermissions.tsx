import { useTranslation } from 'react-i18next'
import {
  ADMIN_PERMISSION_CATALOG,
  hasPermission,
  hasWildcard,
  ROLE_LABEL_KEYS,
  type AdminPermissionInfo,
  type StepUpRule,
} from '@/api/permissions'
import { Card, Pill, SectionLabel } from '@/components/admin'
import shell from '../Page.module.css'

const STEP_UP_KEYS: Record<StepUpRule, string> = {
  always: 'adminPermissions.stepUpAlways',
  config: 'adminPermissions.stepUpConfig',
  partial: 'adminPermissions.stepUpPartial',
}

interface Row {
  key: string
  info: AdminPermissionInfo | null
}

/**
 * 概览上的「我的角色」与「我的权限」：两块分开——角色只是身份标识，本站能做什么只看权限
 * （IAM 权限快照，可能含角色之外单独授予的项）。数据就是登录时拿到的 /me，不额外请求任何后台接口，
 * 所以只要能进后台的人都能看到，也不会越权。
 */
export function MyPermissions({ roles, permissions }: { roles: string[]; permissions: string[] }) {
  const { t } = useTranslation()
  const wildcard = hasWildcard(permissions)
  const labelOf = (key: string) => {
    const info = ADMIN_PERMISSION_CATALOG.find((p) => p.key === key)
    return info ? t(info.labelKey) : key
  }

  /* 表里列什么：目录部分——通配时目录里全部（已迁移不用的除外，除非快照里明确有），否则自己持有的；
     再追加快照里目录外的权限（IAM 可能新增），原样列出并说明本站没有用到。通配与否都追加。 */
  const catalogRows = ADMIN_PERMISSION_CATALOG.filter((p) =>
    wildcard ? !p.legacy || permissions.includes(p.key) : permissions.includes(p.key),
  ).map((info) => ({ key: info.key, info }))
  const extraRows = [...new Set(permissions)]
    .filter((p) => p !== '*' && !ADMIN_PERMISSION_CATALOG.some((c) => c.key === p))
    .map((key) => ({ key, info: null }))
  const rows: Row[] = [...catalogRows, ...extraRows]

  return (
    <>
      <Card>
        <SectionLabel>{t('adminPermissions.rolesTitle')}</SectionLabel>
        {roles.length > 0 ? (
          <div className={shell.chipRow}>
            {roles.map((r) => (
              <Pill key={r} tone="accent">
                {ROLE_LABEL_KEYS[r] ? t(ROLE_LABEL_KEYS[r]) : r}
              </Pill>
            ))}
          </div>
        ) : (
          <p className={shell.noteText}>{t('adminPermissions.rolesNone')}</p>
        )}
        <p className={shell.subtleNoteSpaced}>{t('adminPermissions.rolesNote')}</p>
      </Card>

      <Card>
        <SectionLabel>{t('adminPermissions.tableTitle')}</SectionLabel>
        {wildcard && <p className={shell.noteText}>{t('adminPermissions.wildcard')}</p>}
        {rows.length === 0 ? (
          <p className={shell.noteText}>{t('adminPermissions.none')}</p>
        ) : (
          <table className={shell.permTable}>
            <caption className={shell.srOnly}>{t('adminPermissions.tableTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('adminPermissions.colPermission')}</th>
                <th scope="col">{t('adminPermissions.colScope')}</th>
                <th scope="col">{t('adminPermissions.colKey')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, info }) => {
                // 依赖的权限没有：这一项在后台暂时用不上（比如能审核却打不开投稿详情）
                const missing = info?.requires && !hasPermission(permissions, info.requires) ? info.requires : null
                return (
                  <tr key={key} className={info?.legacy || !info ? shell.permRowMuted : undefined}>
                    <th scope="row" className={shell.permName}>
                      {info ? t(info.labelKey) : key}
                    </th>
                    <td className={shell.permScope}>
                      <span>{info ? t(info.scopeKey) : t('adminPermissions.unknownScope')}</span>
                      {info?.stepUp && <Pill>{t(STEP_UP_KEYS[info.stepUp])}</Pill>}
                      {missing && (
                        <span className={shell.permWarn}>
                          {t('adminPermissions.requiresMissing', { name: labelOf(missing) })}
                        </span>
                      )}
                    </td>
                    <td className={shell.permKey}>
                      <code>{key}</code>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}
