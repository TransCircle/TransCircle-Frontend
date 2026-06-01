/**
 * ULID generator: 26-char Crockford Base32, 48-bit timestamp + 80-bit random.
 * Sorted by timestamp for rough chronological ordering.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_MAP: Record<string, string> = {};
for (let i = 0; i < 32; i++) {
  CROCKFORD_MAP[CROCKFORD[i]] = CROCKFORD[i];
}

/** Generate a ULID string */
export function ulid(): string {
  const now = Date.now();
  const ts = now.toString(16).padStart(12, '0');
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = ts + Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');

  // Encode hex to Crockford Base32 (first 48 bits = 10 chars, remaining 80 bits = 16 chars)
  let result = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < hex.length; i++) {
    value = (value << 4) | parseInt(hex[i], 16);
    bits += 4;
    if (bits >= 5) {
      bits -= 5;
      result += CROCKFORD[(value >> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    result += CROCKFORD[(value << (5 - bits)) & 31];
  }

  return result.padEnd(26, CROCKFORD[0]).slice(0, 26);
}

/** Extract timestamp from a ULID (first 10 chars encode the 48-bit timestamp) */
export function ulidTimestamp(id: string): number {
  let ts = 0;
  for (let i = 0; i < 10; i++) {
    const idx = CROCKFORD.indexOf(id[i]?.toUpperCase() ?? '0');
    if (idx === -1) continue;
    ts = (ts << 5) | idx;
  }
  return ts;
}
