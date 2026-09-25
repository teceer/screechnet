// SCREECHNET modem core: framing, modulation and the dial-up handshake.
// Pure functions, no DOM — shared by the page and the Node loopback test.
import { RS } from './crypto.js';
import { COSTAS, MARK, HEADER_BYTES, BLOCK_BYTES, MAGIC, blockSymbols, encodeBlock } from './fec.js';

// FSK modes: space = bit 0, mark = bit 1 (also the idle "carrier" tone).
// TANK: 16 hopping tones (base + j·spacing), one per `symbol` seconds, with FEC.
export const MODES = [
  { id: 'tank', type: 'mfsk', name: 'TANK', rate: '34 bps', symbol: 0.04, base: 800, spacing: 50, hint: 'bad calls · FEC' },
  { id: 'robust', type: 'fsk', code: 0x52, name: 'ROBUST', rate: '100 bd', baud: 100, space: 1600, mark: 2000, hint: 'good calls' },
  { id: 'bell103', type: 'fsk', code: 0x42, name: 'BELL 103', rate: '300 bd', baud: 300, space: 1070, mark: 1270, hint: 'the 1962 classic' },
  { id: 'bell202', type: 'fsk', code: 0x46, name: 'BELL 202', rate: '1200 bd', baud: 1200, space: 2200, mark: 1200, hint: 'same room only' },
];

export const SYN = 0x16, STX = 0x02, EOT = 0x04, US = 0x1f;
export const MAX_PAYLOAD = 2048;
const PREAMBLE = [SYN, SYN, SYN, SYN, STX];

// Payload is the same in every mode: nick, US, UTF-8 text — or, with a room key,
// that whole thing sealed (see crypto.js), which starts with RS.
export function payloadBytes(nick, text) {
  const enc = new TextEncoder();
  const nickBytes = enc.encode(nick.replace(/[\x1e\x1f]/g, '').slice(0, 16));
  const payload = [...nickBytes, US, ...enc.encode(text)];
  if (payload.length > MAX_PAYLOAD) throw new Error('message too long');
  return { payload, textOffset: nickBytes.length + 1 };
}

export function splitPayload(bytes) {
  const i = bytes.indexOf(US), dec = (b) => new TextDecoder().decode(Uint8Array.from(b));
  return i < 0 ? { nick: '', text: dec(bytes) } : { nick: dec(bytes.slice(0, i)), text: dec(bytes.slice(i + 1)) };
}

// Streams payload bytes out as nick + text, decoding UTF-8 as it goes.
// A sealed payload can't be read until it's complete: its bytes go to onCipher instead
// and the whole thing is handed over in onEnd({ sealed }).
class PayloadStream {
  constructor(h) {
    this.h = h;
    this.nick = [];
    this.inText = false;
    this.first = true;
    this.sealed = null;
    this.dec = new TextDecoder();
  }
  push(b) {
    if (this.first) {
      this.first = false;
      if (b === RS) {
        this.sealed = [b];
        this.h.onSealed?.();
        return;
      }
    }
    if (this.sealed) {
      this.sealed.push(b);
      this.h.onCipher?.([b]);
    } else if (this.inText) this.emit([b]);
    else if (b === US) this.startText(this.nick);
    else if (this.nick.length < 48) this.nick.push(b);
    else {
      // No separator where one should be: treat everything as text.
      this.startText([]);
      this.emit([...this.nick, b]);
    }
  }
  // Undecodable stretch (a lost FEC block): show placeholders and resync UTF-8.
  gap(n) {
    if (this.first || this.sealed) {
      // a sealed message with a hole in it can never be opened; keep the length for the UI
      this.first = false;
      this.sealed ??= [];
      this.sealed.push(...new Array(n).fill(0));
      this.sealed.broken = true;
      this.h.onCipher?.(new Array(n).fill(null));
      return;
    }
    if (!this.inText) this.startText(this.nick);
    this.flush();
    this.h.onText?.('░'.repeat(n));
  }
  startText(nickBytes) {
    this.inText = true;
    this.h.onNick?.(new TextDecoder().decode(new Uint8Array(nickBytes)));
  }
  emit(bytes) {
    const s = this.dec.decode(new Uint8Array(bytes), { stream: true });
    if (s) this.h.onText?.(s);
  }
  flush() {
    const tail = this.dec.decode();
    if (tail) this.h.onText?.(tail);
  }
  end() {
    if (this.sealed) return this.sealed.broken ? null : this.sealed;
    if (!this.inText) this.startText(this.nick);
    this.flush();
    return null;
  }
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// Frame: SYN×4 STX | CODE LEN_HI LEN_LO | nick US text | CRC_HI CRC_LO | EOT
// Each byte goes on the air as async 8N1, exactly like a 1990s serial modem.
export function buildFrame(mode, payload) {
  const body = [mode.code, payload.length >> 8, payload.length & 0xff, ...payload];
  const crc = crc16(body);
  return Uint8Array.from([...PREAMBLE, ...body, crc >> 8, crc & 0xff, EOT]);
}

const LEAD = 0.3, TAIL = 0.08;
const WARMUP = [0, 2, 4, 6, 8, 10, 12, 14]; // lets the phone's AGC settle before the Costas sync

const mfskSymbols = (len) =>
  WARMUP.length + COSTAS.length + blockSymbols(HEADER_BYTES) + Math.ceil(len / BLOCK_BYTES) * (MARK.length + blockSymbols(BLOCK_BYTES));

// Seconds on air for a payload of `len` bytes.
export function airtime(mode, len) {
  if (mode.type === 'mfsk') return mfskSymbols(len) * mode.symbol + 0.05;
  const bits = Math.ceil(LEAD * mode.baud) + (len + PREAMBLE.length + 6) * 10 + Math.ceil(TAIL * mode.baud);
  return bits / mode.baud;
}

// Payload → audio. payloadEnds[i] = time at which payload byte i is fully on air.
export function encodeMessage(mode, payload, fs) {
  if (mode.type === 'mfsk') {
    const { samples } = modulateMfsk(mode, payload, fs);
    const before = WARMUP.length + COSTAS.length + blockSymbols(HEADER_BYTES), per = MARK.length + blockSymbols(BLOCK_BYTES);
    const payloadEnds = payload.map((_, i) => (before + per * (Math.floor(i / BLOCK_BYTES) + 1)) * mode.symbol);
    return { samples, payloadEnds };
  }
  const { samples, byteTimes } = modulate(mode, buildFrame(mode, payload), fs);
  const payloadEnds = payload.map((_, i) => byteTimes[PREAMBLE.length + 3 + i] + 10 / mode.baud);
  return { samples, payloadEnds };
}

export function mfskTones(payload) {
  const len = payload.length;
  const tones = [...WARMUP, ...COSTAS, ...encodeBlock([MAGIC, len >> 8, len & 0xff])];
  for (let i = 0; i < len; i += BLOCK_BYTES) {
    const blk = payload.slice(i, i + BLOCK_BYTES);
    while (blk.length < BLOCK_BYTES) blk.push(0);
    tones.push(...MARK, ...encodeBlock(blk));
  }
  return tones;
}

// Continuous-phase MFSK: one of 16 tones per symbol.
export function modulateMfsk(mode, payload, fs, amp = 0.7) {
  const tones = mfskTones(payload);
  const sps = fs * mode.symbol;
  const n = Math.ceil(tones.length * sps + 0.05 * fs);
  const out = new Float32Array(n);
  const ramp = Math.round(0.005 * fs), end = Math.ceil(tones.length * sps);
  let ph = 0;
  for (let i = 0; i < end; i++) {
    ph += (2 * Math.PI * (mode.base + tones[Math.min(tones.length - 1, Math.floor(i / sps))] * mode.spacing)) / fs;
    if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
    const g = i < ramp ? i / ramp : i > end - ramp ? (end - i) / ramp : 1;
    out[i] = amp * g * Math.sin(ph);
  }
  return { samples: out, duration: n / fs };
}

// Continuous-phase FSK. Returns samples plus the air time at which each byte starts.
export function modulate(mode, bytes, fs, amp = 0.7) {
  const bits = [];
  for (let i = Math.ceil(LEAD * mode.baud); i > 0; i--) bits.push(1);
  const byteBits = [];
  for (const b of bytes) {
    byteBits.push(bits.length);
    bits.push(0);
    for (let k = 0; k < 8; k++) bits.push((b >> k) & 1);
    bits.push(1);
  }
  for (let i = Math.ceil(TAIL * mode.baud); i > 0; i--) bits.push(1);

  const spb = fs / mode.baud;
  const n = Math.ceil(bits.length * spb);
  const out = new Float32Array(n);
  const ramp = Math.round(0.005 * fs);
  const wm = (2 * Math.PI * mode.mark) / fs, ws = (2 * Math.PI * mode.space) / fs;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += bits[Math.min(bits.length - 1, Math.floor(i / spb))] ? wm : ws;
    if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
    const g = i < ramp ? i / ramp : i > n - ramp ? (n - i) / ramp : 1;
    out[i] = amp * g * Math.sin(ph);
  }
  return { samples: out, byteTimes: byteBits.map((b) => b / mode.baud), duration: n / fs };
}

// Byte-level receiver for one FSK mode. Hunts for SYN SYN STX, then reads the frame,
// streaming decoded text out as it arrives so it "types itself" on screen.
export class FrameParser {
  constructor(mode, handlers) {
    this.mode = mode;
    this.h = handlers;
    this.reset();
  }

  reset() {
    this.st = 'hunt';
    this.sr = 0;
    this.out = null;
  }

  push(b) {
    switch (this.st) {
      case 'hunt':
        this.sr = ((this.sr << 8) | b) & 0xffffff;
        if (this.sr === ((SYN << 16) | (SYN << 8) | STX)) this.st = 'code';
        break;
      case 'code':
        if (b === this.mode.code) {
          this.body = [b];
          this.st = 'len1';
        } else this.reset();
        break;
      case 'len1':
        this.body.push(b);
        this.len = b << 8;
        this.st = 'len2';
        break;
      case 'len2':
        this.body.push(b);
        this.len |= b;
        if (this.len === 0 || this.len > MAX_PAYLOAD) return this.reset();
        this.got = 0;
        this.out = new PayloadStream(this.h);
        this.st = 'payload';
        this.h.onStart?.();
        break;
      case 'payload':
        this.body.push(b);
        this.out.push(b);
        if (++this.got === this.len) this.st = 'crc1';
        break;
      case 'crc1':
        this.crc = b << 8;
        this.st = 'crc2';
        break;
      case 'crc2': {
        const ok = crc16(this.body) === (this.crc | b);
        this.finish(ok, ok ? null : 'CRC ERROR (line noise)');
        break;
      }
    }
  }

  finish(ok, reason) {
    const sealed = this.out.end();
    this.h.onEnd?.({ ok, reason, sealed });
    this.reset();
  }

  carrierLost() {
    if (this.out) this.finish(false, 'NO CARRIER');
    else this.reset();
  }
}

// Receiver side for TANK: the demodulator hands over FEC-decoded blocks; a block that
// fails its CRC shows up as ░ instead of taking the whole message down with it.
export class BlockAssembler {
  constructor(handlers) {
    this.h = handlers;
    this.out = null;
  }

  header(len) {
    this.len = len;
    this.got = 0;
    this.bad = 0;
    this.blocks = Math.ceil(len / BLOCK_BYTES);
    this.out = new PayloadStream(this.h);
    this.h.onStart?.();
  }

  block(bytes, ok) {
    if (!this.out) return;
    const take = Math.min(BLOCK_BYTES, this.len - this.got);
    if (ok) bytes.slice(0, take).forEach((b) => this.out.push(b));
    else {
      this.bad++;
      this.out.gap(take);
    }
    this.got += take;
  }

  end() {
    if (!this.out) return;
    const sealed = this.out.end();
    const ok = this.bad === 0;
    this.h.onEnd?.({ ok, reason: ok ? null : `${this.bad}/${this.blocks} BLOCKS LOST`, sealed });
    this.out = null;
  }

  carrierLost() {
    if (!this.out) return;
    this.out.end();
    this.h.onEnd?.({ ok: false, reason: 'NO CARRIER', sealed: null });
    this.out = null;
  }
}

// ——— The handshake. Not a real V.90 negotiation, but it sounds like one. ———

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336],
  6: [770, 1477], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], 0: [941, 1336],
};

export function synthHandshake(fs, number = '5550199') {
  const rnd = mulberry32(1995);
  const segs = [];
  const marks = {};
  let t = 0;
  const len = (d) => Math.round(d * fs);
  const fade = len(0.004);
  const env = (i, n) => Math.min(1, i / fade, (n - i) / fade);
  const add = (a) => {
    segs.push(a);
    t += a.length / fs;
  };
  const silence = (d) => add(new Float32Array(len(d)));
  const gen = (d, f) => {
    const n = len(d), a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = f(i, n) * env(i, n);
    add(a);
  };
  const tones = (freqs, d, amp) =>
    gen(d, (i) => (amp / freqs.length) * freqs.reduce((s, f) => s + Math.sin((2 * Math.PI * f * i) / fs), 0));

  marks.dial = t;
  tones([350, 440], 0.9, 0.35);
  silence(0.2);
  marks.dtmf = t;
  for (const ch of number) {
    tones(DTMF[ch], 0.085, 0.4);
    silence(0.06);
  }
  silence(0.5);
  marks.ring = t;
  tones([440, 480], 1.1, 0.3);
  silence(0.7);

  // ANSam-ish answer tone: 2100 Hz with a phase reversal every 450 ms
  marks.answer = t;
  const flip = len(0.45);
  gen(1.5, (i) => 0.3 * Math.sin((2 * Math.PI * 2100 * i) / fs + (Math.floor(i / flip) % 2) * Math.PI));
  silence(0.07);

  // V.8 exchange: both ends chatter in V.21 FSK at 300 baud
  marks.v8 = t;
  {
    const spb = fs / 300;
    const a = [...Array(400)].map(() => rnd() > 0.5), b = [...Array(400)].map(() => rnd() > 0.5);
    let p1 = 0, p2 = 0;
    gen(0.8, (i) => {
      const k = Math.floor(i / spb);
      p1 += (2 * Math.PI * (a[k] ? 980 : 1180)) / fs;
      p2 += (2 * Math.PI * (b[k] ? 1650 : 1850)) / fs;
      return 0.2 * Math.sin(p1) + 0.2 * Math.sin(p2);
    });
  }
  silence(0.06);

  // V.34 line probing: the famous "bong-bong"
  marks.probe = t;
  const phases = [...Array(25)].map(() => rnd() * 2 * Math.PI);
  for (let r = 0; r < 2; r++) {
    gen(0.17, (i) => (0.3 / 6) * phases.reduce((s, ph, k) => s + Math.cos((2 * Math.PI * 150 * (k + 1) * i) / fs + ph), 0));
    silence(0.06);
  }
  silence(0.06);

  // Training: scrambled QAM at 2400 baud — the long "shhhhhh"
  marks.train = t;
  {
    const spb = fs / 2400, lv = [-3, -1, 1, 3];
    let I = 0, Q = 0, si = 0, sq = 0, last = -1;
    gen(2.3, (i, n) => {
      const k = Math.floor(i / spb);
      if (k !== last) {
        last = k;
        I = lv[(rnd() * 4) | 0];
        Q = lv[(rnd() * 4) | 0];
      }
      si += (I - si) * 0.3;
      sq += (Q - sq) * 0.3;
      const w = (2 * Math.PI * 1829 * i) / fs;
      const swell = 0.75 + 0.25 * Math.sin((i / n) * Math.PI * 6);
      return 0.075 * swell * (si * Math.cos(w) - sq * Math.sin(w)) + 0.02 * (rnd() - 0.5);
    });
  }
  marks.connect = t;

  const out = new Float32Array(segs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of segs) {
    out.set(a, o);
    o += a.length;
  }
  return { samples: out, marks, duration: t };
}
