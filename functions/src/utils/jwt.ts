import { conf } from '../Config';

const sessionConf = conf.SESSION as Record<string, string | number | undefined>;
const JWT_SECRET = (sessionConf.SESS_SECRET as string) || 'default-secret-change-me';

const ALGO = { name: 'HMAC', hash: 'SHA-256' } as const;

function b64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64UrlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function getKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(JWT_SECRET));
  return crypto.subtle.importKey('raw', digest, ALGO, false, ['sign', 'verify']);
}

export interface JwtPayload {
  sub: string;
  sessionId: string;
  tokenVersion: number;
  isAdmin: boolean;
  iat: number;
  exp: number;
}

/** Sign a JWT with HMAC-SHA256 */
export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64UrlEncode(new TextEncoder().encode(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + 900, // 15 minutes (per api.md §1)
  })));

  const key = await getKey();
  const signature = await crypto.subtle.sign(ALGO, key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify and decode a JWT. Returns null if invalid/expired. */
export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const key = await getKey();
    // Cast through unknown for TS 6.0 BufferSource strictness
    const decodedSig = b64UrlDecode(parts[2]) as unknown as BufferSource;
    const valid = await crypto.subtle.verify(
      ALGO,
      key,
      decodedSig,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(parts[1]))) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
