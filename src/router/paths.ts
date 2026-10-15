/**
 * 路由匹配默认不区分大小写、也接受结尾斜杠：/search/、/Search 都会命中 /search 路由。
 * 凡是按路径字符串做的判断（页面标题、导航当前项），先规范化再比较，
 * 否则会出现「页面照常显示，标题却是“页面未找到”、导航也没有当前项」。
 */
export function normalizePathname(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return (trimmed || '/').toLowerCase()
}
