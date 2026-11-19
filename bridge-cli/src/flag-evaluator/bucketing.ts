/**
 * flagd's bucketing, exactly (flagd core, `fractional`): MurmurHash3 (x86,
 * 32 bits, seed 0) over the deterministic CBOR encoding of the bucketing
 * input, mapped onto the total weight as `(hash * total) >> 32`. A flag's
 * rollouts use the input `[salt, bucketing value]`, flagd's own default
 * `[flagKey, targetingKey]` with the salt fixed when the flag is made, over
 * 100,000 buckets, so a rollout moves in steps of 0.001 % and a person's
 * bucket never changes.
 */

/** The buckets a rollout counts in: 10 % is buckets 0 to 9,999. */
export const BUCKETS = 100_000;

const encoder = new TextEncoder();

/** MurmurHash3, x86, 32 bits, over bytes. */
export function murmur3(bytes: Uint8Array, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = bytes.length >>> 2;
  for (let i = 0; i < blocks; i++) {
    const at = i * 4;
    let k = ((bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16) | ((bytes[at + 3] as number) << 24)) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  const tail = blocks * 4;
  const rest = bytes.length & 3;
  if (rest > 0) {
    let k = 0;
    if (rest === 3) k ^= (bytes[tail + 2] as number) << 16;
    if (rest >= 2) k ^= (bytes[tail + 1] as number) << 8;
    k ^= bytes[tail] as number;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= bytes.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A CBOR head: the major type and the length, in the shortest form (RFC 8949, deterministic encoding). */
function head(major: number, length: number): number[] {
  const type = major << 5;
  if (length < 24) return [type | length];
  if (length < 0x100) return [type | 24, length];
  if (length < 0x10000) return [type | 25, length >>> 8, length & 0xff];
  return [type | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/** Deterministic CBOR of a text string, or of an array of text strings: what flagd hashes. */
export function cbor(value: string | readonly string[]): Uint8Array {
  const text = (each: string) => {
    const bytes = encoder.encode(each);
    return [...head(3, bytes.length), ...bytes];
  };
  return Uint8Array.from(typeof value === "string" ? text(value) : [...head(4, value.length), ...value.flatMap(text)]);
}

/** flagd's mapping of a hash onto weights totalling `total`: a bucket in [0, total). */
export function bucketOfHash(hash: number, total: number): number {
  // hash < 2^32 and total < 2^21 keep the product exact in a double; dividing by 2^32 is exact too.
  return Math.floor((hash * total) / 0x1_0000_0000);
}

/** The bucket of one bucketing value for a flag's salt, in [0, BUCKETS). */
export function bucketOf(salt: string, value: string): number {
  return bucketOfHash(murmur3(cbor([salt, value])), BUCKETS);
}

/** Whether a bucket falls inside a rollout of `pct` percent (0 to 100, three decimals). */
export function inRollout(bucket: number, pct: number): boolean {
  return bucket < Math.round(pct * (BUCKETS / 100));
}
