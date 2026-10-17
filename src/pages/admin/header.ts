import { createContext, useContext, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { BadgeTone } from '@/components/admin'
import type { AdminSection } from '@/router/handles'

export interface AdminHeaderState {
  title: string
  /** 标题旁的一句说明；窄工作区里隐藏。 */
  subtitle?: string
  /** 详情页的返回入口；列表页不给。focusRow：回到列表后重新聚焦的那一行。 */
  back?: { to: string; label: string; focusRow?: string }
  /** 标题后的状态徽标（详情页的当前状态）。用数据而不是节点，避免每次渲染都触发一次写入。 */
  badge?: { tone: BadgeTone; label: string }
  /** 左栏当前分区；不给时取路由 handle 的。投稿详情据来源改成审核队列或投稿管理。 */
  section?: AdminSection
}

/** 写入的同时记下是哪条路径写的：换页后、新页面还没写之前，外壳不会把上一页的标题挂在新页上。 */
export type AdminHeaderEntry = AdminHeaderState & { path: string }

type Setter = (entry: AdminHeaderEntry) => void

export const AdminHeaderContext = createContext<Setter>(() => {})

/**
 * 页面把自己的标题交给外壳渲染（同 Pass 控制台）。
 *
 * 标题栏在工作区顶部、内容区之外，只能由外壳画；但标题内容——尤其详情页的实体名——
 * 只有页面知道。外壳不再按 pathname 去猜标题。
 */
export function useAdminPageHeader(header: AdminHeaderState): void {
  const set = useContext(AdminHeaderContext)
  const { pathname } = useLocation()
  const { title, subtitle, back, badge, section } = header
  useEffect(() => {
    set({ title, subtitle, back, badge, section, path: pathname })
    // back / badge 每次渲染都是新对象，按内容取依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, pathname, title, subtitle, section, back?.to, back?.label, back?.focusRow, badge?.tone, badge?.label])
}
