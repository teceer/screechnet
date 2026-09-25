// Loopback test: modulate → fake phone line → demodulate, with every demodulator listening
// to every transmission (so cross-mode false decodes are caught too).
// The VoIP lines drop 20 ms packets, let a jitter buffer cut/duplicate 10 ms of audio (hard cuts,
// harsher than a real WSOLA jitter buffer), wobble the gain like a phone AGC and add noise.
// They are reported as statistics over random channels; TANK must keep most messages intact on "bad VoIP".
// Usage: node test/loopback.mjs
import { MODES, encodeMessage, payloadBytes, splitPayload, FrameParser, BlockAssembler, synthHandshake } from '../modem.js';
import { FskDemod, MfskDemod } from '../demod.js';
import { deriveRoomKey, seal, open, SEAL_OVERHEAD } from '../crypto.js';

function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function biquad(x, fs, type, f0, q = 0.707) {
  const w = (2 * Math.PI * f0) / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function phoneLine(sig, fs, { snrDb, drift, gain, loss = 0, warp = 0, agc = 0 }, rnd) {
  const pad = new Float32Array(Math.round(fs * 0.4));
  let x = Float32Array.from([...pad, ...sig, ...pad]);
  x = biquad(biquad(x, fs, 'hp', 300), fs, 'lp', 3400);

  // VoIP: 20 ms packets, some lost (zeroed); jitter buffer occasionally drops or repeats 10 ms
  const pk = Math.round(fs * 0.02), chunks = [];
  for (let i = 0; i < x.length; i += pk) {
    let c = x.slice(i, i + pk);
    if (rnd() < loss) c = new Float32Array(c.length);
    const r = rnd();
    if (r < warp / 2) c = c.slice(0, c.length / 2);
    else if (r < warp) c = Float32Array.from([...c, ...c.slice(0, c.length / 2)]);
    chunks.push(c);
  }
  x = Float32Array.from(chunks.flatMap((c) => [...c]));

  const n = Math.floor(x.length / drift), y = new Float32Array(n);
  let ph = rnd() * 6;
  for (let i = 0; i < n; i++) {
    const p = i * drift, j = Math.floor(p), f = p - j;
    const g = gain * (1 + agc * Math.sin(ph + (2 * Math.PI * 0.7 * i) / fs)); // slow AGC wobble
    y[i] = (x[j] * (1 - f) + (x[j + 1] ?? 0) * f) * g;
  }
  const sigPow = (sig.reduce((s, v) => s + v * v, 0) / sig.length) * gain * gain;
  const nAmp = Math.sqrt((sigPow / 10 ** (snrDb / 10)) * 3);
  for (let i = 0; i < n; i++) y[i] += nAmp * (rnd() * 2 - 1);
  return y;
}

function receive(samples, fs) {
  const results = MODES.map(() => []);
  const demods = MODES.map((mode, k) => {
    let text = '', nick = '';
    const h = {
      onNick: (v) => (nick = v),
      onText: (s) => (text += s),
      onEnd: ({ ok, reason, sealed }) => {
        results[k].push({ ok, reason, nick, text, sealed });
        text = '';
      },
    };
    if (mode.type === 'mfsk') {
      const a = new BlockAssembler(h), d = new MfskDemod(mode, fs);
      d.onHeader = (len) => a.header(len);
      d.onBlock = (b, ok) => a.block(b, ok);
      d.onEnd = () => a.end();
      d.onLost = () => a.carrierLost();
      return d;
    }
    const p = new FrameParser(mode, h), d = new FskDemod(mode, fs);
    d.onByte = (b) => p.push(b);
    d.onCarrier = (on) => !on && p.carrierLost();
    return d;
  });
  for (const x of samples) for (const d of demods) d.push(x);
  return results;
}

const TEXT = 'Hello from 1995! Zażółć gęślą jaźń 🦖 ATDT';
const lines = [
  { name: 'clean', snrDb: 60, drift: 1, gain: 1 },
  { name: 'quiet+noisy 12dB', snrDb: 12, drift: 1.0002, gain: 0.05 },
  { name: 'rough 6dB, drift', snrDb: 6, drift: 0.9995, gain: 0.3 },
];
const VOIP = {
  'bad VoIP (5% loss, jitter ~2 s, 6 dB)': { snrDb: 6, drift: 1.0003, gain: 0.2, loss: 0.05, warp: 0.01, agc: 0.3 },
  'brutal VoIP (8% loss, jitter ~0.5 s, 3 dB)': { snrDb: 3, drift: 1.0003, gain: 0.2, loss: 0.08, warp: 0.04, agc: 0.5 },
};
const MIN_TANK_INTACT = { 'bad VoIP (5% loss, jitter ~2 s, 6 dB)': 10 }; // of 12

function trial(mode, line, fs, seed) {
  const rnd = mulberry(seed);
  const { samples } = encodeMessage(mode, payloadBytes('wojtek', TEXT).payload, fs);
  const res = receive(phoneLine(samples, fs, line, rnd), fs);
  const k = MODES.indexOf(mode);
  const mine = res[k];
  const good = mine.length === 1 && mine[0].ok && mine[0].text === TEXT && mine[0].nick === 'wojtek';
  const okGhosts = res.filter((_, j) => j !== k).flat().filter((g) => g.ok).length;
  return { good, okGhosts, mine };
}

let fail = 0;
for (const fs of [44100, 48000]) {
  for (const mode of MODES) {
    for (const line of lines) {
      const { good, okGhosts, mine } = trial(mode, line, fs, fs + lines.indexOf(line) * 7 + MODES.indexOf(mode));
      const required = !line.only || line.only === mode.id;
      const pass = good && okGhosts === 0;
      if (required && !pass) fail++;
      const tag = pass ? 'PASS' : required ? 'FAIL' : 'miss';
      console.log(`${tag}  ${fs}Hz  ${mode.name.padEnd(8)}  ${line.name.padEnd(18)}  ` +
        (good ? 'decoded ok' : JSON.stringify(mine).slice(0, 110)) + (okGhosts ? `  GHOST FRAMES: ${okGhosts}` : ''));
    }
  }
  const hs = receive(synthHandshake(fs).samples, fs).flat();
  const hsPass = hs.every((r) => !r.ok);
  if (!hsPass) fail++;
  console.log(`${hsPass ? 'PASS' : 'FAIL'}  ${fs}Hz  handshake produces no valid frame (${hs.length} aborted)`);
}

// VoIP lines: messages fully intact / FEC blocks lost, per mode, over random channels.
// (FSK modes have no blocks: one error kills the whole message.)
const blocks = Math.ceil(payloadBytes('wojtek', TEXT).payload.length / 8);
for (const [name, line] of Object.entries(VOIP)) {
  console.log(`\n${name}, 12 random channels @48k:`);
  for (const mode of MODES) {
    let ok = 0, lost = 0;
    for (let s = 0; s < 12; s++) {
      const t = trial(mode, line, 48000, 1000 + s);
      ok += t.good ? 1 : 0;
      const m = t.mine[0]?.reason?.match(/(\d+)\/(\d+)/);
      lost += t.good ? 0 : m ? +m[1] : blocks;
    }
    const need = mode.type === 'mfsk' ? MIN_TANK_INTACT[name] : undefined;
    if (need !== undefined && ok < need) fail++;
    console.log(`  ${need !== undefined ? (ok >= need ? 'PASS' : 'FAIL') : '    '}  ${mode.name.padEnd(8)} messages intact ${String(ok).padStart(2)}/12` +
      (mode.type === 'mfsk' ? `   blocks lost ${lost}/${12 * blocks}` : ''));
  }
}

// Encryption: round trip, wrong key, tampering, and a sealed message over the air.
{
  const check = (name, cond) => {
    if (!cond) fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  crypto  ${name}`);
  };
  const plain = payloadBytes('wojtek', TEXT).payload;
  const t0 = Date.now();
  const room = await deriveRoomKey('correct horse battery staple');
  const ms = Date.now() - t0;
  const other = await deriveRoomKey('correct horse battery stapler');
  const sealed = await seal(room.key, plain);
  check(`key derivation ${ms} ms, fingerprint ${room.fingerprint} vs ${other.fingerprint}`, room.fingerprint !== other.fingerprint);
  check(`overhead ${sealed.length - plain.length} bytes`, sealed.length - plain.length === SEAL_OVERHEAD);
  const back = await open(room.key, sealed);
  check('round trip', back && splitPayload([...back]).text === TEXT);
  check('wrong key refused', (await open(other.key, sealed)) === null);
  const bent = [...sealed];
  bent[20] ^= 4;
  check('one flipped bit refused', (await open(room.key, bent)) === null);
  check('two seals of the same text differ', JSON.stringify(await seal(room.key, plain)) !== JSON.stringify(sealed));

  const tank = MODES[0], robust = MODES[1];
  for (const [mode, line, seed] of [[tank, { snrDb: 6, drift: 1.0003, gain: 0.2, loss: 0.05, warp: 0.01, agc: 0.3 }, 7], [robust, lines[2], 8]]) {
    const { samples } = encodeMessage(mode, sealed, 48000);
    const res = receive(phoneLine(samples, 48000, line, mulberry(seed)), 48000)[MODES.indexOf(mode)];
    const got = res[0]?.sealed && (await open(room.key, res[0].sealed));
    check(`sealed message over ${mode.name}: decrypted ok, nothing readable before`, res.length === 1 && res[0].text === '' && got && splitPayload([...got]).text === TEXT);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall required passed');
process.exit(fail ? 1 : 0);
