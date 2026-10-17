import { Fragment, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

/**
 * 详情路由按 :id 重挂：React Router 在同一路由间换参数时会复用组件实例，
 * 而详情页的在途请求、写操作锁、草稿都属于「这一条」。整页重挂让卸载清理一并作废它们，
 * 不必在组件里再维护一套「换了一条」的会话判断。
 */
export function KeyedById({ children }: { children: ReactNode }) {
  const { id = '' } = useParams()
  return <Fragment key={id}>{children}</Fragment>
}
