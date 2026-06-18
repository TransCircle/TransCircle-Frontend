export function limitByUnicode(str: string, max: number): string {
  return [...str].slice(0, max).join('')
}
