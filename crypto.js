// End-to-end encryption with a shared room key (a passphrase both sides type in).
// WebCrypto only, works in the browser and in Node.
//
//   key     = PBKDF2-SHA256(passphrase, fixed salt, 600k iterations) → AES-256-GCM
//   sealed  = RS | nonce (8 B, random) | ciphertext | tag (8 B)
//
// Every byte costs air time (~0.25 s in TANK), so the envelope is trimmed to 17 bytes:
// a 64-bit random nonce is safe for ~4 billion messages per key, and a 64-bit tag still
// makes a forged or damaged message fail to open with probability 1 − 2⁻⁶⁴.

export const RS = 0x1e; // first payload byte of a sealed message (never starts a plain one)
const NONCE_BYTES = 8;
const TAG_BITS = 64;
const ITERATIONS = 600_000;
const SALT = new TextEncoder().encode('screechnet/v1/room-key');
export const SEAL_OVERHEAD = 1 + NONCE_BYTES + TAG_BITS / 8;

// Only the 8 random bytes go on the air; AES-GCM gets the standard 96-bit IV (zero padded),
// which every WebCrypto implementation accepts.
const gcmIv = (nonce) => Uint8Array.from([...nonce, 0, 0, 0, 0]);

// → { key, fingerprint } — the fingerprint ("3F-A9-C2") lets both sides check over the call
// that they typed the same passphrase. It comes from separate PBKDF2 output bits, so
// showing it reveals nothing about the AES key.
export async function deriveRoomKey(passphrase) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' }, base, 384),
  );
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const fingerprint = [...bits.slice(32, 35)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');
  return { key, fingerprint };
}

export async function seal(key, plain) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: gcmIv(nonce), tagLength: TAG_BITS }, key, Uint8Array.from(plain)));
  return [RS, ...nonce, ...ct];
}

// → plaintext bytes, or null if the key is wrong or a single bit was damaged on the line
export async function open(key, sealed) {
  if (sealed[0] !== RS || sealed.length < SEAL_OVERHEAD) return null;
  const iv = gcmIv(sealed.slice(1, 1 + NONCE_BYTES));
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: TAG_BITS }, key, Uint8Array.from(sealed.slice(1 + NONCE_BYTES)));
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
