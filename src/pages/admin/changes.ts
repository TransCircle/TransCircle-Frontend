import { useEffect, useRef } from 'react'

/**
 * 后台实体变更的进程内广播。
 *
 * 详情是独立路由：写请求在途时用户可以离开详情、回到列表，甚至重新打开同一条。
 * 那个旧详情实例已经卸载——它不能再弹 step-up、写错误、跳转（这些属于已经结束的会话），
 * 但「写成功了」这件事仍要让屏幕上的列表和同一条详情知道，否则它们会一直显示写入前的状态。
 * 数据失效与旧会话的界面副作用因此分开：成功就广播，由当前挂着的页面各自决定重读。
 */
export type AdminEntityKind = 'contribution' | 'editRequest' | 'user' | 'comment'

export interface AdminChange {
  kind: AdminEntityKind
  id: string
  /** 评论：它回复的顶层评论（顶层评论为 null）。父评论详情据此知道「我的某条回复变了」，不必靠截断后的回复列表认。 */
  parentId?: string | null
  /** 发出变更的那个页面实例；它自己已经在处理后续（跳转或重读），收到自己的广播时忽略。 */
  source: object
}

type Listener = (change: AdminChange) => void

const listeners = new Set<Listener>()

export function emitAdminChange(change: AdminChange): void {
  for (const listener of [...listeners]) listener(change)
}

/** 订阅变更；handler 总是读最新的那一个，不必放进依赖。 */
export function useAdminChange(handler: Listener): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })
  useEffect(() => {
    const listener: Listener = (change) => handlerRef.current(change)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
