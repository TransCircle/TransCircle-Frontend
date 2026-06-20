/**
 * Convert ArrayBuffer to base64url encoding.
 * Used for WebAuthn (Passkey) and API binary data encoding.
 */
export function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * Unicode-aware string truncation by character count (not UTF-16 code units)
 */
export function limitByUnicode(str: string, max: number): string {
  return [...str].slice(0, max).join('')
}
