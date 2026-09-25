import { MODE, encodeMessage, payloadBytes, splitPayload, BlockAssembler, synthHandshake, airtime } from './modem.js';
import { deriveRoomKey, seal, open, SEAL_OVERHEAD } from './crypto.js';
import { track } from './analytics.js';

const $ = (s) => document.querySelector(s);
const term = $('#term');
const fall = $('#fall');
const msgBox = $('#msg');
const nickBox = $('#nick');
const sendBtn = $('#send');
const dialBtn = $('#dial');
const powerBtn = $('#power');
const echoBox = $('#echo');
const keyBox = $('#key');
const keyStatus = $('#key-status');
const enc = new TextEncoder();

let ctx = null, stream = null, analyser = null, txBus = null, rxNode = null;
let busy = false;
let room = null; // { key, fingerprint } — derived from the room key, kept in memory only

// ——— storage (per-viewer conveniences only) ———
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ——— LEDs ———
const leds = Object.fromEntries([...document.querySelectorAll('.led')].map((el) => [el.dataset.led, el]));
const blinkTimers = {};
const led = (name, on) => leds[name].classList.toggle('on', !!on);
function blink(name, ms = 45) {
  led(name, true);
  clearTimeout(blinkTimers[name]);
  blinkTimers[name] = setTimeout(() => led(name, false), ms);
}

// ——— terminal ———
const stamp = () => new Date().toTimeString().slice(0, 8);
function stickToBottom(fn) {
  const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  fn();
  if (atBottom) term.scrollTop = term.scrollHeight;
}
function line(text, cls = 'sys') {
  const el = document.createElement('div');
  el.className = 'ln ' + cls;
  el.textContent = text;
  stickToBottom(() => term.append(el));
  return el;
}
function msgEl(kind, meta) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.innerHTML = '<div class="meta"></div><div class="body"><span class="nick"></span><span class="text"></span><span class="pending"></span><i class="caret"></i><span class="verdict"></span></div>';
  el.querySelector('.meta').textContent = meta;
  stickToBottom(() => term.append(el));
  return {
    el,
    nick: (n) => (el.querySelector('.nick').textContent = n || 'anon'),
    text: (t) => stickToBottom(() => el.querySelector('.text').append(t)),
    set: (sent, pending) => {
      el.querySelector('.text').textContent = sent;
      el.querySelector('.pending').textContent = pending;
    },
    end: (ok, verdict, cls = ok ? 'ok' : 'bad') => {
      el.classList.remove('ok', 'bad', 'locked');
      el.classList.add('done', cls);
      el.querySelector('.verdict').textContent = ' ' + verdict;
    },
    // sealed message: ciphertext streams in as hex, then "decrypts" into the text
    sealed: () => {
      el.classList.add('sealed');
      el.querySelector('.nick').textContent = '🔒';
    },
    cipher: (bytes) =>
      stickToBottom(() =>
        el.querySelector('.text').append(bytes.map((b) => (b === null ? '░░' : b.toString(16).padStart(2, '0'))).join(' ') + ' '),
      ),
    reveal: (nick, text) =>
      new Promise((done) => {
        el.classList.add('opened');
        el.querySelector('.nick').textContent = '🔓 ' + (nick || 'anon');
        const t = el.querySelector('.text'), chars = Array.from(text), glyphs = '0123456789abcdef';
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const start = performance.now(), dur = reduced ? 0 : Math.min(1400, 300 + chars.length * 25);
        const frame = (now) => {
          const p = dur ? Math.min(1, (now - start) / dur) : 1, n = Math.floor(p * chars.length);
          t.textContent = chars.slice(0, n).join('') + chars.slice(n).map((c) => (c === ' ' ? ' ' : glyphs[(Math.random() * 16) | 0])).join('');
          if (p < 1) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      }),
  };
}

function boot() {
  [
    'SCREECHNET MODEM BIOS v1.0  (c) 1995-2026',
    '',
    'READY. FLIP THE POWER SWITCH TO GO ONLINE.',
    '',
    '  1. CALL A FRIEND. PUT THE PHONE ON SPEAKER.',
    '  2. BOTH OF YOU OPEN THIS PAGE AND POWER ON.',
    '  3. TYPE. TRANSMIT. LISTEN TO THE SCREECH.',
  ].forEach((t) => line(t, t.startsWith('READY') ? 'hi' : 'sys'));
}

// ——— band guides & meters ———
$('#guides').innerHTML = [MODE.base, MODE.base + 15 * MODE.spacing]
  .map((f) => `<div class="guide" style="left:${(f / 4000) * 100}%"></div>`)
  .join('');
$('#meters').innerHTML =
  `<div class="meter" id="m-in">IN <span class="bar"><i></i></span></div>` +
  `<div class="meter" id="m-sync">SYNC <span class="bar"><i></i></span></div>`;
let carrier = false;
function updateMeters({ rms, lock }) {
  const db = 20 * Math.log10(rms + 1e-9);
  $('#m-in i').style.width = Math.max(0, Math.min(100, ((db + 70) / 70) * 100)) + '%';
  $('#m-sync i').style.width = (carrier ? 100 : Math.min(100, (lock / 0.35) * 100)) + '%';
  $('#m-sync').classList.toggle('lock', carrier);
}

// ——— receive ———
// Sealed messages we couldn't open yet: retried whenever the room key changes.
const locked = new Set();

async function tryOpen(v) {
  const { sealed, link, linkOk } = v.pending;
  if (!room) {
    locked.add(v);
    track('message_decrypt', { result: 'no_key' });
    return v.end(false, `${link} · 🔒 ENCRYPTED: ENTER THE ROOM KEY TO READ`, 'locked');
  }
  const r = room, pt = await open(r.key, sealed);
  if (r !== room) return; // key changed meanwhile; the change retries it
  if (!pt) {
    track('message_decrypt', { result: linkOk ? 'wrong_key' : 'damaged' });
    if (!linkOk) return v.end(false, `${link} · DAMAGED ON THE LINE, CAN'T DECRYPT`);
    locked.add(v);
    return v.end(false, `${link} · 🔒 WRONG ROOM KEY (sender used another one)`, 'locked');
  }
  locked.delete(v);
  track('message_decrypt', { result: 'ok' });
  const { nick, text } = splitPayload([...pt]);
  await v.reveal(nick, text);
  v.end(true, `${link} · 🔓 DECRYPTED`);
}

const view = { current: null };
const parser = new BlockAssembler({
  onStart: () => {
    view.current = msgEl('in', `${stamp()}  RING · CONNECT ${MODE.rate} ${MODE.name}`);
  },
  onNick: (n) => view.current?.nick(n),
  onText: (t) => view.current?.text(t),
  onSealed: () => view.current?.sealed(),
  onCipher: (b) => view.current?.cipher(b),
  onEnd: ({ ok, reason, sealed }) => {
    const v = view.current;
    view.current = null;
    line('NO CARRIER');
    if (!v) return;
    const link = ok ? '✓ FEC OK' : `✗ ${reason}`;
    const lost = reason?.match(/(\d+)\/(\d+)/);
    track('message_received', {
      ok,
      encrypted: v.el.classList.contains('sealed'),
      lost_carrier: reason === 'NO CARRIER',
      blocks_lost: lost ? +lost[1] : 0,
      blocks: lost ? +lost[2] : undefined,
    });
    if (!v.el.classList.contains('sealed')) return v.end(ok, link);
    if (!sealed) return v.end(false, `${link} · DAMAGED ON THE LINE, CAN'T DECRYPT`);
    v.pending = { sealed, link, linkOk: ok };
    tryOpen(v);
  },
});

function onRx({ data: m }) {
  if (m.t === 'hdr') parser.header(m.len);
  else if (m.t === 'blk') {
    parser.block(m.bytes, m.ok);
    blink('RD', 120);
  } else if (m.t === 'end') parser.end();
  else if (m.t === 'lost') parser.carrierLost();
  else if (m.t === 'cd') led('CD', (carrier = m.on));
  else if (m.t === 'stat') updateMeters(m);
}

const mute = (v) => rxNode?.port.postMessage({ t: 'mute', v: v && !echoBox.checked });

// ——— power ———
async function powerOn() {
  powerBtn.setAttribute('aria-pressed', 'true');
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.15;
  txBus = ctx.createGain();
  txBus.connect(ctx.destination);
  txBus.connect(analyser);

  term.textContent = '';
  led('MR', true);
  led('TR', true);
  line('ATZ', 'hi');
  line('OK');
  line(`SAMPLE RATE ${ctx.sampleRate} HZ`);

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const mic = ctx.createMediaStreamSource(stream);
    mic.connect(analyser);
    await ctx.audioWorklet.addModule('rx-worklet.js');
    rxNode = new AudioWorkletNode(ctx, 'modem-rx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { mode: MODE },
    });
    rxNode.port.onmessage = onRx;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    mic.connect(rxNode).connect(sink).connect(ctx.destination);
    line('ATS0=1', 'hi');
    line('OK — AUTO ANSWER. LISTENING');
    track('power_on', { mic: true, sample_rate: ctx.sampleRate });
    led('AA', true);
    led('OH', true);
  } catch (e) {
    line(`NO MICROPHONE (${e.message || e.name}). TRANSMIT ONLY.`, 'err');
    track('power_on', { mic: false, mic_error: e.name, sample_rate: ctx.sampleRate });
  }
  line('');
  line('READY. TYPE BELOW AND HIT TRANSMIT.', 'hi');
  msgBox.disabled = false;
  dialBtn.disabled = false;
  updateEta();
  msgBox.focus();
}

async function powerOff() {
  powerBtn.setAttribute('aria-pressed', 'false');
  stream?.getTracks().forEach((t) => t.stop());
  await ctx?.close();
  ctx = stream = analyser = txBus = rxNode = null;
  busy = false;
  carrier = false;
  parser.carrierLost();
  Object.keys(leds).forEach((n) => led(n, false));
  msgBox.disabled = dialBtn.disabled = sendBtn.disabled = true;
  line('');
  line('ATH0 — HUNG UP. POWER OFF.', 'err');
}

powerBtn.onclick = () => (ctx ? powerOff() : powerOn().catch((e) => line('POWER FAULT: ' + e.message, 'err')));

// ——— transmit ———
function play(samples) {
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(txBus);
  const t0 = ctx.currentTime + 0.06;
  src.start(t0);
  return { t0, ended: new Promise((r) => (src.onended = r)) };
}

function setBusy(v) {
  busy = v;
  updateEta();
  dialBtn.disabled = v || !ctx;
}

async function transmit(text) {
  const nick = nickBox.value.trim();
  const r = room;
  const { payload: plain, textOffset } = payloadBytes(nick, text);
  const payload = r ? await seal(r.key, plain) : plain;
  const { samples, payloadEnds } = encodeMessage(payload, ctx.sampleRate);
  setBusy(true);
  mute(true);

  track('message_sent', {
    bytes: payload.length,
    chars: Array.from(text).length,
    encrypted: !!r,
    airtime_s: +airtime(payload.length).toFixed(1),
    local_echo: echoBox.checked,
  });
  const view = msgEl('out', `${stamp()}  ATDT · SENDING ${MODE.rate} ${MODE.name} · ${payload.length} BYTES` +
    (r ? ` · 🔒 AES-GCM KEY ${r.fingerprint}` : ''));
  view.nick((r ? '🔒 ' : '') + (nick || 'anon'));
  // for each character: how many payload bytes must be on the air before it's shown as sent
  // (sealed: ciphertext has no per-character position, so just go by the fraction sent)
  const chars = Array.from(text);
  let acc = textOffset;
  const ends = r ? chars.map((_, i) => ((i + 1) / chars.length) * payload.length) : chars.map((c) => (acc += enc.encode(c).length));
  view.set('', text);

  const { t0, ended } = play(samples);
  let lastSent = -1, raf;
  const tick = () => {
    const el = ctx ? ctx.currentTime - t0 : Infinity;
    let sentBytes = 0;
    while (sentBytes < payloadEnds.length && payloadEnds[sentBytes] <= el) sentBytes++;
    if (el > 0 && Math.floor(el * 12) % 2) blink('SD', 40);
    if (sentBytes !== lastSent) {
      lastSent = sentBytes;
      let n = 0;
      while (n < ends.length && ends[n] <= sentBytes) n++;
      view.set(chars.slice(0, n).join(''), chars.slice(n).join(''));
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  await ended;
  cancelAnimationFrame(raf);
  view.set(text, '');
  view.end(true, '✓ SENT');
  setTimeout(() => mute(false), 250);
  setBusy(false);
}

async function dial() {
  if (busy || !ctx) return;
  track('handshake_played');
  setBusy(true);
  mute(true);
  const hs = synthHandshake(ctx.sampleRate);
  const { t0, ended } = play(hs.samples);
  led('OH', true);
  const steps = [
    ['dial', 'ATDT 555-0199', 'hi'],
    ['ring', 'RINGING...'],
    ['answer', 'ANSWER TONE 2100 HZ'],
    ['v8', 'V.8 NEGOTIATION'],
    ['probe', 'LINE PROBING'],
    ['train', 'TRAINING EQUALIZER'],
    ['connect', 'CONNECT 56000/ARQ/V90/LAPM/V42BIS', 'hi'],
  ];
  const lead = (t0 - ctx.currentTime) * 1000;
  const timers = steps.map(([k, text, cls]) => setTimeout(() => line(text, cls), lead + hs.marks[k] * 1000));
  const blinker = setInterval(() => blink('SD', 30), 90);
  await ended;
  clearInterval(blinker);
  timers.forEach(clearTimeout);
  if (ctx) {
    line('(JUST KIDDING. REAL SPEED IS WHATEVER YOU PICKED ABOVE.)');
    mute(false);
  }
  setBusy(false);
}
dialBtn.onclick = dial;

// ——— compose ———
function updateEta() {
  const text = msgBox.value;
  $('#count').textContent = `${Array.from(text).length}/280`;
  const n = payloadBytes(nickBox.value.trim(), text).payload.length + (keyBox.value ? SEAL_OVERHEAD : 0);
  $('#eta').textContent = `≈ ${airtime(n).toFixed(1)} s on air${keyBox.value ? ' · encrypted' : ''}`;
  sendBtn.textContent = keyBox.value ? 'TRANSMIT 🔒' : 'TRANSMIT ▶';
  sendBtn.disabled = !ctx || busy || !text.trim() || (!!keyBox.value && !room);
}

// ——— room key ———
let keyGen = 0, keyTimer;
function setKeyStatus(cls, html) {
  keyStatus.className = 'key-status ' + cls;
  keyStatus.innerHTML = html;
}
keyBox.addEventListener('input', () => {
  const gen = ++keyGen, pass = keyBox.value;
  room = null;
  clearTimeout(keyTimer);
  updateEta();
  if (!pass) return setKeyStatus('', '🔓 OPEN LINE: anyone on the call can decode your messages');
  setKeyStatus('busy', '… deriving key');
  keyTimer = setTimeout(async () => {
    const r = await deriveRoomKey(pass);
    if (gen !== keyGen) return;
    room = r;
    track('room_key_set');
    setKeyStatus('on', `🔒 PRIVATE LINE · key ID <b>${r.fingerprint}</b>. Read it to your friend: it must match theirs.`);
    updateEta();
    for (const v of [...locked]) tryOpen(v);
  }, 350);
});
$('#key-eye').onclick = (e) => {
  const show = keyBox.type === 'password';
  keyBox.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'hide' : 'show';
  e.currentTarget.setAttribute('aria-pressed', String(show));
};

$('#compose').onsubmit = (e) => {
  e.preventDefault();
  const text = msgBox.value.trim();
  if (!ctx || busy || !text) return;
  msgBox.value = '';
  transmit(text).catch((err) => {
    line('TX FAULT: ' + err.message, 'err');
    setBusy(false);
    mute(false);
  });
};
msgBox.addEventListener('input', updateEta);
msgBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#compose').requestSubmit();
  }
});
nickBox.addEventListener('input', () => {
  store.set('screechnet.nick', nickBox.value);
  updateEta();
});
echoBox.addEventListener('change', () => {
  track('local_echo_toggled', { on: echoBox.checked });
  store.set('screechnet.echo', echoBox.checked ? '1' : '');
  if (echoBox.checked) mute(false);
});

// ——— waterfall ———
const fctx = fall.getContext('2d', { willReadFrequently: false });
const palette = Array.from({ length: 256 }, (_, v) => {
  const x = Math.max(0, (v - 70) / 185);
  return [Math.round(255 * Math.max(0, x - 0.7) / 0.3 * 0.8), Math.round(255 * Math.min(1, x * 1.3)), Math.round(40 * x + 255 * Math.max(0, x - 0.75) * 2.4)];
});
let row = null, bins = null;
function sizeFall() {
  const w = Math.min(1024, Math.round(fall.clientWidth * Math.min(2, devicePixelRatio || 1)));
  if (fall.width !== w) {
    fall.width = w;
    fall.height = 130;
    row = fctx.createImageData(w, 1);
  }
}
function draw() {
  requestAnimationFrame(draw);
  if (!analyser) return;
  sizeFall();
  if (!bins || bins.length !== analyser.frequencyBinCount) bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const W = fall.width, H = fall.height;
  fctx.drawImage(fall, 0, 0, W, H - 1, 0, 1, W, H - 1);
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  for (let x = 0; x < W; x++) {
    const v = bins[Math.min(bins.length - 1, Math.floor(((x / W) * 4000) / hzPerBin))];
    const [r, g, b] = palette[v];
    const o = x * 4;
    row.data[o] = r;
    row.data[o + 1] = g;
    row.data[o + 2] = b;
    row.data[o + 3] = 255;
  }
  fctx.putImageData(row, 0, 0);
}

// ——— init ———
nickBox.value = store.get('screechnet.nick') || '';
echoBox.checked = store.get('screechnet.echo') === '1';
updateEta();
boot();
requestAnimationFrame(draw);

$('#share').addEventListener('click', () => track('share_clicked'));
$('#source').addEventListener('click', () => track('source_clicked'));
$('#share').href =
  'https://x.com/intent/post?text=' +
  encodeURIComponent('I just sent a message over a phone call with my laptop screeching like a 1995 modem 📞🔊') +
  '&url=' + encodeURIComponent(location.origin + location.pathname);
