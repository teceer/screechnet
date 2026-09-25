// Forward error correction + symbol mapping for the TANK (MFSK16) mode.
// Shared by the transmitter (page), the receiver (AudioWorklet) and the Node tests.
//
// A block is: data bytes + CRC-16 → rate-1/2 K=7 convolutional code (the Voyager/802.11 one)
// → bit interleaver (so a dropped VoIP packet becomes scattered single-bit errors)
// → 4 bits per symbol, Gray-coded onto 16 tones (a near miss costs one bit, not four).

export const BLOCK_BYTES = 8;
export const HEADER_BYTES = 3;
export const MAGIC = 0xa5;
const K = 7, G1 = 0o171, G2 = 0o133, NSTATES = 1 << (K - 1);

// Welch Costas array of order 16 (3^i mod 17): sharp autocorrelation in time and tone,
// so the receiver can find the start of a transmission even deep in noise.
export const COSTAS = Array.from({ length: 16 }, (_, i) => {
  let v = 1;
  for (let j = 0; j <= i; j++) v = (v * 3) % 17;
  return v - 1;
});

// Short re-sync marker sent before every block: big tone jumps give a sharp timing peak.
export const MARK = [3, 12, 0, 15];

export const gray = (v) => v ^ (v >> 1);
// tone index → the 4 coded bits it carries
export const TONE_BITS = Array.from({ length: 16 }, (_, t) => {
  let v = t;
  for (let s = t >> 1; s; s >>= 1) v ^= s;
  return v;
});

// CRC-16 per block: the receiver may try several timing hypotheses per block,
// so the check has to be strong enough that a wrong one never slips through.
export function crc16(bytes) {
  let c = 0x1d0f;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

const parity = (x) => {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
};

function convEncode(bits) {
  const out = [];
  let st = 0;
  for (const u of [...bits, 0, 0, 0, 0, 0, 0]) {
    const reg = (u << (K - 1)) | st;
    out.push(parity(reg & G1), parity(reg & G2));
    st = reg >> 1;
  }
  return out;
}

// Soft-decision Viterbi. soft[i] > 0 means "probably 1", magnitude = confidence, 0 = erasure.
function viterbi(soft) {
  const steps = soft.length / 2;
  let pm = new Float64Array(NSTATES).fill(-1e9);
  pm[0] = 0;
  const prev = new Uint8Array(steps * NSTATES);
  const bit = new Uint8Array(steps * NSTATES);
  for (let t = 0; t < steps; t++) {
    const a = soft[2 * t], b = soft[2 * t + 1];
    const next = new Float64Array(NSTATES).fill(-1e9);
    for (let s = 0; s < NSTATES; s++) {
      if (pm[s] < -1e8) continue;
      for (let u = 0; u < 2; u++) {
        const reg = (u << (K - 1)) | s, ns = reg >> 1;
        const m = pm[s] + (parity(reg & G1) ? a : -a) + (parity(reg & G2) ? b : -b);
        if (m > next[ns]) {
          next[ns] = m;
          prev[t * NSTATES + ns] = s;
          bit[t * NSTATES + ns] = u;
        }
      }
    }
    pm = next;
  }
  const out = new Array(steps);
  for (let t = steps - 1, s = 0; t >= 0; t--) {
    out[t] = bit[t * NSTATES + s];
    s = prev[t * NSTATES + s];
  }
  return out.slice(0, steps - (K - 1));
}

// Column-wise read of a row-wise filled grid: neighbours on air are far apart in the code.
const perms = new Map();
function interleaveOrder(n) {
  if (!perms.has(n)) {
    const C = Math.ceil(Math.sqrt(n)), order = [];
    for (let c = 0; c < C; c++) for (let r = 0; r * C + c < n; r++) order.push(r * C + c);
    perms.set(n, order);
  }
  return perms.get(n);
}

export const blockSymbols = (nBytes) => ((nBytes + 2) * 8 + K - 1) / 2; // 2 coded bits, 4 per symbol

export function encodeBlock(bytes) {
  const crc = crc16(bytes);
  const data = [...bytes, crc >> 8, crc & 0xff];
  const bits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
  const coded = convEncode(bits);
  const tx = interleaveOrder(coded.length).map((i) => coded[i]);
  const syms = [];
  for (let i = 0; i < tx.length; i += 4) syms.push(gray((tx[i] << 3) | (tx[i + 1] << 2) | (tx[i + 2] << 1) | tx[i + 3]));
  return syms;
}

// softSyms: per symbol, 4 soft bits (MSB first) in air order.
export function decodeBlock(softBits, nBytes) {
  const order = interleaveOrder(softBits.length);
  const coded = new Float64Array(softBits.length);
  order.forEach((codePos, airPos) => (coded[codePos] = softBits[airPos]));
  const bits = viterbi(coded);
  const bytes = [];
  for (let i = 0; i < nBytes + 2; i++) bytes.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  const data = bytes.slice(0, nBytes);
  return { bytes: data, ok: crc16(data) === ((bytes[nBytes] << 8) | bytes[nBytes + 1]) };
}

// Energies of 16 tones → 4 soft bits (max-log approximation), scaled by confidence w.
export function softBitsFromSpectrum(E, w) {
  const a = Array.from(E, Math.sqrt);
  const top = Math.max(...a) || 1;
  const out = [];
  for (let b = 3; b >= 0; b--) {
    let one = 0, zero = 0;
    for (let t = 0; t < 16; t++) {
      if ((TONE_BITS[t] >> b) & 1) one = Math.max(one, a[t]);
      else zero = Math.max(zero, a[t]);
    }
    out.push(((one - zero) / top) * w);
  }
  return out;
}
