import { useCallback, useRef } from 'react'
import { newIdempotencyKey, setIntentKey } from '@/api/client'

/**
 * 业务意图级的幂等键。
 *
 * api.md §12：同一次「业务意图」的所有重试必须携带同一个 Idempotency-Key，
 * 服务端才能把「请求已到达、但响应在回程丢了」的那次重试认出来是同一件事。
 *
 * 每次点提交都现生成一个新键，等于向服务端宣告「这是一件新的事」——网络抖动
 * 之后用户再点一次，就会多出一条评论、一篇投稿、一份编辑申请。client.ts 里
 * 「网络错误时保留 intent key」的用心，也会被调用方的新键当场作废。
 *
 * 用法：
 *   const { begin, settle } = useIntentKey()
 *   begin(signature)                       // 发请求前；内容没变就复用上次的键
 *   const result = await post(..., { idempotent: true })
 *   settle(isRetryableFailure(result))     // 可重试的失败保留键，其余作废
 */
export function useIntentKey() {
  const ref = useRef<{ sig: string; key: string } | null>(null)

  /** signature 描述这次意图的内容（目标 + 正文）：变了才换新键。 */
  const begin = useCallback((sig: string) => {
    if (ref.current?.sig !== sig) ref.current = { sig, key: newIdempotencyKey() }
    setIntentKey(ref.current.key)
  }, [])

  /** 结束本次意图。retryable 为 true 时保留键，供用户原样重试复用。 */
  const settle = useCallback((retryable: boolean) => {
    if (!retryable) ref.current = null
    setIntentKey(null)
  }, [])

  return { begin, settle }
}
