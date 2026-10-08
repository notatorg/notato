const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Random bytes: the platform's crypto when it has one (Hermes may not), else Math.random, which is enough for ids. */
function randomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    const crypto = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } })
        .crypto;
    if (crypto?.getRandomValues) return crypto.getRandomValues(bytes);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
}

/** A ULID: 26 characters, sorting by time, as every other Notato SDK makes an annotation's id. */
export function ulid(now: number = Date.now()): string {
    let time = "";
    let t = now;
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[t % 32] + time;
        t = Math.floor(t / 32);
    }
    let random = "";
    for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32];
    return time + random;
}
