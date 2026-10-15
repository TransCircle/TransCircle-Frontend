import type { ReactNode } from 'react'
import { canEnterAdmin, hasPermission, PERMISSIONS } from '@/api/permissions'
import type { AdminSection } from '@/router/handles'
import { AuditIcon, CommentsIcon, EditIcon, InboxIcon, OverviewIcon, StackIcon, UsersIcon } from './navIcons'

export interface AdminNavItem {
  section: AdminSection
  to: string
  labelKey: string
  icon: ReactNode
}

export interface AdminNavGroup {
  /** 组标签；概览不归组。 */
  labelKey: string | null
  items: AdminNavItem[]
}

/**
 * 左栏分区（按权限过滤后的结果）。外壳画左栏、/admin 落点分流都用这一份，
 * 两处不会对「谁能看到哪个分区」各算一套。
 */
export function adminNavGroups(permissions: string[]): AdminNavGroup[] {
  const can = (p: string) => hasPermission(permissions, p)
  const contribution = can(PERMISSIONS.CONTRIBUTION_READ)
  const groups: AdminNavGroup[] = [
    {
      // 概览向所有能进后台的人开放（自己的角色与权限表），里面的统计再按权限显示
      labelKey: null,
      items: canEnterAdmin(permissions)
        ? [{ section: 'overview', to: '/admin/overview', labelKey: 'adminShell.navOverview', icon: <OverviewIcon /> }]
        : [],
    },
    {
      labelKey: 'adminShell.groupContent',
      items: [
        ...(contribution
          ? [
              { section: 'review', to: '/admin/review', labelKey: 'adminShell.navReview', icon: <InboxIcon /> },
              {
                section: 'contributions',
                to: '/admin/contributions',
                labelKey: 'adminShell.navContributions',
                icon: <StackIcon />,
              },
            ]
          : []),
        // 修改申请的接口要求投票权限，与投稿读取分开判断（同路由守卫）
        ...(can(PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE)
          ? [
              {
                section: 'editRequests',
                to: '/admin/edit-requests',
                labelKey: 'adminShell.navEditRequests',
                icon: <EditIcon />,
              },
            ]
          : []),
        ...(can(PERMISSIONS.COMMENT_MODERATE)
          ? [{ section: 'comments', to: '/admin/comments', labelKey: 'adminShell.navComments', icon: <CommentsIcon /> }]
          : []),
      ] as AdminNavItem[],
    },
    {
      labelKey: 'adminShell.groupPeople',
      items: [
        ...(can(PERMISSIONS.USER_READ)
          ? [{ section: 'users', to: '/admin/users', labelKey: 'adminShell.navUsers', icon: <UsersIcon /> }]
          : []),
        ...(can(PERMISSIONS.AUDIT_READ)
          ? [{ section: 'auditLogs', to: '/admin/audit-logs', labelKey: 'adminShell.navAudit', icon: <AuditIcon /> }]
          : []),
      ] as AdminNavItem[],
    },
  ]
  return groups.filter((g) => g.items.length > 0)
}

/** /admin 的落点：首个有权限的分区；一个都没有时返回 null。 */
export function adminLandingPath(permissions: string[]): string | null {
  return adminNavGroups(permissions)[0]?.items[0]?.to ?? null
}
